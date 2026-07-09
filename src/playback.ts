// Playback engine behind an interface (ADR-0001 §5): the MVP engine is
// WebView <audio> elements + Web Audio. If WKWebView's format ceiling
// (FLAC) or true sample-level gapless forces a native engine
// (symphonia + cpal), only this file changes — UI code never touches
// the engine directly.
//
// Two-deck architecture: each track plays on a Deck (audio element +
// gain node). The next track preloads on the idle deck and starts the
// moment the current one ends — near-gapless (the seam is one event
// loop turn, not a src-swap + network + decode). The deck graph is
// also the substrate crossfade needs: two simultaneously audible
// sources with independent gains.

import { convertFileSrc } from "@tauri-apps/api/core";
import { effectiveGain } from "./gain";
import type { TransitionPlan } from "./djmix";

export interface TrackSource {
  path: string;
  /** ReplayGain track gain in dB; null = no data, play at unity. */
  replaygainDb: number | null;
}

export interface PlaybackEngine {
  /** Start playing a local file; resolves when playback begins. */
  play(source: TrackSource): Promise<void>;
  /** Preload a track on the idle deck for gapless handoff; null clears. */
  preloadNext(source: TrackSource | null): void;
  /** Execute a planned transition into the preloaded track NOW.
      `outgoingPath` is the track the plan fades OUT of: if the active
      deck no longer plays it (planning raced a track change — slow
      anchor analysis can outlive the track), the plan is stale and is
      dropped. The deck clock is checked too: a plan for a playback
      that restarted or paused is equally stale even on the same path.
      Returns false if stale or if the preload isn't ready (caller
      falls back to letting the track end naturally). */
  beginTransition(plan: TransitionPlan, outgoingPath: string): boolean;
  /** True while a transition is running (UI: both tracks audible). */
  readonly transitioning: boolean;
  togglePause(): void;
  seek(secs: number): void;
  readonly paused: boolean;
  /** Current playback position in milliseconds. */
  readonly positionMs: number;
  /** Audio-graph output latency in ms (sent but not yet heard); 0
      until the graph exists. Lyrics subtract this from the clock. */
  readonly outputLatencyMs: number;
  readonly currentTime: number;
  /** NaN until the engine has loaded metadata for the current file. */
  readonly duration: number;
  volume: number;
  /** Analyser for visualizers; null until first play(). */
  readonly analyser: AnalyserNode | null;
  /** Fires when a track ends. If the ended track was gaplessly handed
      off to the preloaded one, `advancedTo` carries its path. */
  onEnded(cb: (advancedTo: string | null) => void): void;
  /** Fires when a transition hands control to the incoming track. */
  onTransitionAdvance(cb: (path: string) => void): void;
  onError(cb: (message: string) => void): void;
  /** ~4Hz progress ticks while playing (media timeupdate cadence). */
  onTimeUpdate(cb: (secs: number) => void): void;
}

/** One audio element + its gain node, addressable inside the graph. */
interface Deck {
  audio: HTMLAudioElement;
  gain: GainNode | null;
  /** What's loaded (or loading) on this deck. */
  source: TrackSource | null;
}

/** Extra seconds beyond the fade length the outgoing deck may still
    have left and count as "ending": covers the caller's 1s arming
    lead plus bar quantization shortening a beat-matched plan by up
    to half a bar (~1.7s at 70 BPM). */
const END_WINDOW_SLACK_SEC = 3;

class TwoDeckEngine implements PlaybackEngine {
  private decks: [Deck, Deck];
  private active = 0;
  private ctx: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private volumeValue = 1;
  /** Source queued for gapless handoff (loaded on the idle deck). */
  private next: TrackSource | null = null;
  private endedCb: ((advancedTo: string | null) => void) | null = null;
  private transitionAdvanceCb: ((path: string) => void) | null = null;
  private errorCb: ((message: string) => void) | null = null;
  private timeCb: ((secs: number) => void) | null = null;
  /** rAF id of the beat-matched rate-ramp loop; 0 when idle. */
  private transitionRaf = 0;
  /** setTimeout id of the transition finalizer; 0 when idle. Fades are
      scheduled on the audio clock and complete even if WKWebView
      freezes rAF in a hidden window. */
  private transitionTimer = 0;
  /** True from beginTransition until the incoming deck actually sounds
      (its play() resolves) and the fades are armed on the audio clock.
      Together with the timer this backs `transitioning`. */
  private transitionPending = false;
  /** Monotonic transition token: bumping it strands an in-flight fade
      anchor still waiting on the incoming deck's play(). */
  private transitionEpoch = 0;
  /** Retires the outgoing deck of the running transition; null when
      idle. Runs on the timer normally, or early from seek() — a seek
      mid-fade invalidates the plan's premise (this tail against this
      head), so the incoming track wins immediately. */
  private finalizeTransition: (() => void) | null = null;

  constructor() {
    this.decks = [this.makeDeck(0), this.makeDeck(1)];
  }

  private makeDeck(index: number): Deck {
    const deck: Deck = { audio: new Audio(), gain: null, source: null };
    deck.audio.preload = "auto";
    deck.audio.addEventListener("ended", () => {
      if (this.deckIndex(deck) !== this.active) return;
      const advanced = this.tryGaplessAdvance();
      this.endedCb?.(advanced);
    });
    deck.audio.addEventListener("timeupdate", () => {
      if (this.deckIndex(deck) === this.active) this.timeCb?.(deck.audio.currentTime);
    });
    deck.audio.addEventListener("error", () => {
      if (this.deckIndex(deck) !== this.active) return; // preload errors surface on switch
      const err = deck.audio.error;
      // MEDIA_ERR_SRC_NOT_SUPPORTED (4) is the WKWebView format ceiling.
      const message =
        err?.code === 4
          ? "Format not supported by the WebView engine"
          : `Playback error (code ${err?.code ?? "?"})`;
      this.errorCb?.(message);
    });
    void index;
    return deck;
  }

  private deckIndex(deck: Deck): number {
    return this.decks[0] === deck ? 0 : 1;
  }

  private get activeDeck(): Deck {
    return this.decks[this.active];
  }

  private get idleDeck(): Deck {
    return this.decks[1 - this.active];
  }

  /** Build the Web Audio graph once (requires a user gesture). */
  private ensureGraph(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.analyserNode = this.ctx.createAnalyser();
    this.analyserNode.fftSize = 4096; // ~10.8Hz/bin at 44.1kHz — enough lows for log binning
    this.analyserNode.smoothingTimeConstant = 0.75;
    this.analyserNode.connect(this.ctx.destination);
    for (const deck of this.decks) {
      const source = this.ctx.createMediaElementSource(deck.audio);
      // WebKit ignores HTMLMediaElement.volume once the element is routed
      // through Web Audio — per-deck GainNodes are the authoritative
      // volume control (user volume × ReplayGain).
      deck.gain = this.ctx.createGain();
      source.connect(deck.gain);
      deck.gain.connect(this.analyserNode);
    }
  }

  private applyGain(deck: Deck): void {
    if (deck.gain) {
      deck.gain.gain.value = effectiveGain(deck.source?.replaygainDb ?? null, this.volumeValue);
    }
  }

  /** Hand off to the preloaded deck if it holds the queued track and is
      ready to start without a fetch/decode stall. */
  private tryGaplessAdvance(): string | null {
    const idle = this.idleDeck;
    if (!this.next || idle.source?.path !== this.next.path) return null;
    // HAVE_FUTURE_DATA(3)+: enough buffered to start immediately.
    if (idle.audio.readyState < 3) return null;
    this.active = 1 - this.active;
    this.next = null;
    this.applyGain(idle);
    void idle.audio.play().catch((e) => this.errorCb?.(String(e)));
    return idle.source.path;
  }

  async play(source: TrackSource): Promise<void> {
    this.ensureGraph();
    if (this.ctx!.state === "suspended") await this.ctx!.resume();
    this.cancelTransition();

    const idle = this.idleDeck;
    // Reuse the preload if it's already sitting on the idle deck.
    if (idle.source?.path !== source.path) {
      idle.audio.src = convertFileSrc(source.path);
      idle.source = source;
    }
    // Stop the old deck only after the new one is ready to sound —
    // play() resolving is the cleanest "it started" signal.
    const previous = this.activeDeck;
    this.active = 1 - this.active;
    this.applyGain(idle);
    try {
      await idle.audio.play();
    } catch (e) {
      this.active = 1 - this.active; // roll back; previous deck still owns playback
      throw e;
    }
    previous.audio.pause();
    previous.audio.removeAttribute("src");
    previous.source = null;
    this.next = null;
  }

  preloadNext(source: TrackSource | null): void {
    this.next = source;
    // Mid-transition the "idle" deck is the still-audible outgoing
    // track — touching its src would cut it dead. Record the intent;
    // the finalizer materializes it once that deck retires.
    if (this.transitioning) return;
    this.materializePreload();
  }

  /** Load `this.next` onto the idle deck (or clear it). Single writer
      for preload deck state — called on preloadNext and on transition
      finalize. */
  private materializePreload(): void {
    const idle = this.idleDeck;
    if (!this.next) {
      if (idle.source) {
        idle.audio.removeAttribute("src");
        idle.source = null;
      }
      return;
    }
    if (idle.source?.path === this.next.path) return;
    idle.audio.src = convertFileSrc(this.next.path);
    idle.source = this.next;
    idle.audio.load();
  }

  get transitioning(): boolean {
    return this.transitionPending || this.transitionTimer !== 0;
  }

  private cancelTransition(): void {
    if (!this.transitioning && !this.transitionRaf) return;
    this.transitionEpoch++; // strand a pending fade anchor, if any
    this.transitionPending = false;
    clearTimeout(this.transitionTimer);
    this.transitionTimer = 0;
    cancelAnimationFrame(this.transitionRaf);
    this.transitionRaf = 0;
    this.finalizeTransition = null;
    const now = this.ctx?.currentTime ?? 0;
    for (const deck of this.decks) {
      deck.gain?.gain.cancelScheduledValues(now);
      deck.audio.playbackRate = 1;
      this.applyGain(deck);
    }
  }

  /** Sample a 0..1 gain curve into audio-clock automation values. */
  private static sampleCurve(
    fn: (t: number) => number,
    base: number,
    durationSec: number,
  ): Float32Array {
    // 100 points/sec (capped): well past audible for gain envelopes.
    const n = Math.max(2, Math.min(1024, Math.ceil(durationSec * 100)));
    const curve = new Float32Array(n);
    for (let k = 0; k < n; k++) curve[k] = base * fn(k / (n - 1));
    return curve;
  }

  /**
   * Execute a transition plan into the preloaded track. The outgoing
   * deck ramps tempo and fades out; the incoming deck enters on its
   * planned offset, tempo-matched, and settles to unity. Both fades
   * anchor to the moment the incoming deck actually sounds (play()
   * resolves) — anchoring at plan-execution time would burn the fade-
   * in's silent head against deck spin-up latency (WKWebView asset
   * fetch + decode, worse after the beat-matched entry seek) and the
   * track would enter mid-slope instead of from silence. From that
   * anchor the fades are scheduled once on the audio clock
   * (setValueCurveAtTime) so they survive a hidden window — WKWebView
   * freezes rAF there, and a frame-driven fade would stall silent.
   * Only playbackRate, which lives on the media element and can't be
   * automated, rides a rAF loop; a wall-clock timer finalizes the
   * handoff.
   */
  beginTransition(plan: TransitionPlan, outgoingPath: string): boolean {
    const from = this.activeDeck;
    const to = this.idleDeck;
    // Stale plan: the track it fades out of already ended or was
    // switched away from while the plan was being computed. Executing
    // it would crossfade the CURRENT track mid-play into the preload.
    if (from.source?.path !== outgoingPath) return false;
    // Same path is not proof either: the user may have restarted or
    // paused the very track the plan fades out of. The plan's premise
    // is "this playback is ending NOW" — verify it on the deck clock.
    if (from.audio.paused) return false;
    const remaining = from.audio.duration - from.audio.currentTime;
    if (Number.isFinite(remaining) && remaining > plan.durationSec + END_WINDOW_SLACK_SEC) {
      return false;
    }
    if (!this.next || to.source?.path !== this.next.path) return false;
    if (to.audio.readyState < 3 || this.transitioning) return false;

    const toPath = to.source.path;

    if (plan.kind === "beatmatched") {
      to.audio.currentTime = plan.incoming.startOffsetSec;
      to.audio.playbackRate = plan.incoming.rateFrom;
    } else {
      to.audio.playbackRate = 1;
    }
    if (to.gain) to.gain.gain.value = 0;

    // The reservation opens now (preloads defer, re-plans are barred)
    // even though the fades arm only once the incoming deck sounds.
    this.transitionPending = true;
    const epoch = ++this.transitionEpoch;

    // Hand off deck ownership immediately: UI follows the incoming track.
    this.active = 1 - this.active;
    this.next = null;
    this.transitionAdvanceCb?.(toPath);

    this.finalizeTransition = () => {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = 0;
      this.transitionPending = false;
      this.transitionEpoch++; // strand a fade anchor still in spin-up
      this.finalizeTransition = null;
      if (this.transitionRaf) {
        cancelAnimationFrame(this.transitionRaf);
        this.transitionRaf = 0;
      }
      from.audio.pause();
      from.audio.removeAttribute("src");
      from.audio.playbackRate = 1;
      from.source = null;
      to.audio.playbackRate = 1;
      // Clear any pending fade automation before restoring unity gain
      // (a no-op on natural completion; load-bearing on early finalize).
      to.gain?.gain.cancelScheduledValues(this.ctx!.currentTime);
      this.applyGain(to);
      // The outgoing deck just retired — load any preload that arrived
      // during the fade (it was deferred to protect this deck's audio).
      this.materializePreload();
    };

    void to.audio.play().then(
      () => {
        // Interrupted during spin-up (play()/seek()/cancel): the epoch
        // moved on and these decks belong to someone else now.
        if (epoch !== this.transitionEpoch) return;
        this.transitionPending = false;

        // Both curves anchor here, where sound actually exists —
        // volume/ReplayGain sampled now so a mid-spin-up wheel of the
        // volume knob still lands in the fade.
        const baseFrom = effectiveGain(from.source?.replaygainDb ?? null, this.volumeValue);
        const baseTo = effectiveGain(to.source?.replaygainDb ?? null, this.volumeValue);
        const now = this.ctx!.currentTime;
        from.gain?.gain.setValueCurveAtTime(
          TwoDeckEngine.sampleCurve(plan.gainOut, baseFrom, plan.durationSec),
          now,
          plan.durationSec,
        );
        to.gain?.gain.setValueCurveAtTime(
          TwoDeckEngine.sampleCurve(plan.gainIn, baseTo, plan.durationSec),
          now,
          plan.durationSec,
        );

        const startedAt = performance.now();
        const durationMs = plan.durationSec * 1000;
        if (plan.kind === "beatmatched") {
          // Linear tempo ramps; audible pitch drift stays within ±8%.
          const tick = () => {
            const t = Math.min(1, (performance.now() - startedAt) / durationMs);
            const o = plan.outgoing;
            const i = plan.incoming;
            from.audio.playbackRate = o.rateFrom + (o.rateTo - o.rateFrom) * t;
            to.audio.playbackRate = i.rateFrom + (i.rateTo - i.rateFrom) * t;
            this.transitionRaf = t < 1 ? requestAnimationFrame(tick) : 0;
          };
          this.transitionRaf = requestAnimationFrame(tick);
        }
        this.transitionTimer = setTimeout(() => this.finalizeTransition?.(), durationMs);
      },
      (e) => {
        if (epoch !== this.transitionEpoch) return;
        // The incoming deck refused to start: surface it and retire the
        // outgoing side anyway — the UI already advanced at handoff.
        this.errorCb?.(String(e));
        this.finalizeTransition?.();
      },
    );
    return true;
  }

  togglePause(): void {
    const { audio } = this.activeDeck;
    if (audio.paused) void audio.play();
    else audio.pause();
  }

  seek(secs: number): void {
    // Seeking mid-fade breaks the plan's premise (this tail against
    // this head): finalize now — outgoing retires, incoming takes
    // full gain — then seek. The UI already follows the incoming
    // track, so this matches what the user believes they're seeking.
    this.finalizeTransition?.();
    this.activeDeck.audio.currentTime = secs;
  }

  get paused(): boolean {
    return this.activeDeck.audio.paused;
  }

  get positionMs(): number {
    return this.activeDeck.audio.currentTime * 1000;
  }

  get outputLatencyMs(): number {
    if (!this.ctx) return 0;
    // outputLatency is absent in some WebViews; baseLatency since ~2018.
    return ((this.ctx.outputLatency ?? 0) + (this.ctx.baseLatency ?? 0)) * 1000;
  }

  get currentTime(): number {
    return this.activeDeck.audio.currentTime;
  }

  get duration(): number {
    return this.activeDeck.audio.duration;
  }

  get volume(): number {
    return this.volumeValue;
  }

  set volume(v: number) {
    this.volumeValue = v;
    for (const deck of this.decks) this.applyGain(deck);
  }

  get analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  onEnded(cb: (advancedTo: string | null) => void): void {
    this.endedCb = cb;
  }

  onTransitionAdvance(cb: (path: string) => void): void {
    this.transitionAdvanceCb = cb;
  }

  onError(cb: (message: string) => void): void {
    this.errorCb = cb;
  }

  onTimeUpdate(cb: (secs: number) => void): void {
    this.timeCb = cb;
  }
}

export function createEngine(): PlaybackEngine {
  return new TwoDeckEngine();
}
