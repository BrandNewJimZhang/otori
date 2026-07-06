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
      Returns false if the preload isn't ready (caller falls back to
      letting the track end naturally). */
  beginTransition(plan: TransitionPlan): boolean;
  /** True while a transition is running (UI: both tracks audible). */
  readonly transitioning: boolean;
  togglePause(): void;
  seek(secs: number): void;
  readonly paused: boolean;
  /** Current playback position in milliseconds. */
  readonly positionMs: number;
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
  /** rAF id of the running transition loop; 0 when idle. */
  private transitionRaf = 0;

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
    const idle = this.idleDeck;
    if (!source) {
      if (idle.source) {
        idle.audio.removeAttribute("src");
        idle.source = null;
      }
      return;
    }
    if (idle.source?.path === source.path) return;
    idle.audio.src = convertFileSrc(source.path);
    idle.source = source;
    idle.audio.load();
  }

  get transitioning(): boolean {
    return this.transitionRaf !== 0;
  }

  private cancelTransition(): void {
    if (this.transitionRaf) {
      cancelAnimationFrame(this.transitionRaf);
      this.transitionRaf = 0;
      for (const deck of this.decks) {
        deck.audio.playbackRate = 1;
        this.applyGain(deck);
      }
    }
  }

  /**
   * Execute a transition plan into the preloaded track. The outgoing
   * deck ramps tempo and fades out; the incoming deck enters on its
   * planned offset, tempo-matched, and settles to unity. Driven by a
   * rAF loop writing playbackRate + gain each frame — WebAudio can
   * ramp gains natively but playbackRate lives on the media element,
   * so one loop drives both for coherence.
   */
  beginTransition(plan: TransitionPlan): boolean {
    const from = this.activeDeck;
    const to = this.idleDeck;
    if (!this.next || to.source?.path !== this.next.path) return false;
    if (to.audio.readyState < 3 || this.transitionRaf) return false;

    const toPath = to.source.path;
    const baseFrom = effectiveGain(from.source?.replaygainDb ?? null, this.volumeValue);
    const baseTo = effectiveGain(to.source?.replaygainDb ?? null, this.volumeValue);

    if (plan.kind === "beatmatched") {
      to.audio.currentTime = plan.incoming.startOffsetSec;
      to.audio.playbackRate = plan.incoming.rateFrom;
    } else {
      to.audio.playbackRate = 1;
    }
    if (to.gain) to.gain.gain.value = 0;
    void to.audio.play().catch((e) => this.errorCb?.(String(e)));

    // Hand off deck ownership immediately: UI follows the incoming track.
    this.active = 1 - this.active;
    this.next = null;
    this.transitionAdvanceCb?.(toPath);

    const startedAt = performance.now();
    const durationMs = plan.durationSec * 1000;
    const tick = () => {
      const t = Math.min(1, (performance.now() - startedAt) / durationMs);
      if (from.gain) from.gain.gain.value = baseFrom * plan.gainOut(t);
      if (to.gain) to.gain.gain.value = baseTo * plan.gainIn(t);
      if (plan.kind === "beatmatched") {
        // Linear tempo ramps; audible pitch drift stays within ±8%.
        const o = plan.outgoing;
        const i = plan.incoming;
        from.audio.playbackRate = o.rateFrom + (o.rateTo - o.rateFrom) * t;
        to.audio.playbackRate = i.rateFrom + (i.rateTo - i.rateFrom) * t;
      }
      if (t < 1) {
        this.transitionRaf = requestAnimationFrame(tick);
      } else {
        this.transitionRaf = 0;
        from.audio.pause();
        from.audio.removeAttribute("src");
        from.audio.playbackRate = 1;
        from.source = null;
        to.audio.playbackRate = 1;
        this.applyGain(to);
      }
    };
    this.transitionRaf = requestAnimationFrame(tick);
    return true;
  }

  togglePause(): void {
    const { audio } = this.activeDeck;
    if (audio.paused) void audio.play();
    else audio.pause();
  }

  seek(secs: number): void {
    this.activeDeck.audio.currentTime = secs;
  }

  get paused(): boolean {
    return this.activeDeck.audio.paused;
  }

  get positionMs(): number {
    return this.activeDeck.audio.currentTime * 1000;
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
