// Playback shell: everything between the play order (playorder.ts,
// pure) and the audio engine (playback.ts). Owns the now-playing
// state (current/paused/position/lyrics/artwork), the play-next queue,
// shuffle/repeat, gapless preload, DJ-crossfade arming, and the engine
// callbacks. App consumes the returned surface; the gold replay suite
// (playback.gold.test.ts) locks the engine-facing behavior.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { planTransition } from "./djmix";
import { getArtwork, getLyrics } from "./ipc";
import { displayTitle } from "./library";
import { headMixPoint, tailMixPoint } from "./mixpoints";
import type { PlaybackEngine } from "./playback";
import { resolveAdvance, shuffledIds, type RepeatMode } from "./playorder";
import type { LyricsDoc, TrackRow } from "./types";

export interface PlaybackShell {
  current: TrackRow | null;
  paused: boolean;
  /** ~4Hz playback position in seconds (engine timeupdate cadence). */
  position: number;
  lyrics: LyricsDoc | null;
  artwork: string | null;
  /** Play-next queue (audit P1): explicit picks preempt the play order. */
  queue: number[];
  setQueue: Dispatch<SetStateAction<number[]>>;
  shuffle: boolean;
  repeat: RepeatMode;
  setRepeat: Dispatch<SetStateAction<RepeatMode>>;
  /** Engine duration once metadata loads; index duration until then. */
  duration: number;
  /** The frozen shuffle permutation, or null when shuffle is off —
      feed to upcomingPreview exactly like the step/preload paths. */
  frozenShuffleOrder(): number[] | null;
  play(track: TrackRow): Promise<void>;
  /** Step the play order; returns false when nothing comes next. */
  step(offset: 1 | -1, manual?: boolean): boolean;
  toggleShuffle(): void;
  seekTo(secs: number): void;
  togglePause(): void;
  /** Live position sampler for Stage's lyric clock rAF loop. */
  getPositionMs(): number;
}

export function usePlaybackShell(
  engine: PlaybackEngine,
  visible: TrackRow[],
  crossfadeSec: number,
  initial: { shuffle: boolean; repeat: RepeatMode },
  onError: (message: string | null) => void,
): PlaybackShell {
  const [current, setCurrent] = useState<TrackRow | null>(null);
  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [lyrics, setLyrics] = useState<LyricsDoc | null>(null);
  const [artwork, setArtwork] = useState<string | null>(null);
  const [queue, setQueue] = useState<number[]>([]);
  const [shuffle, setShuffle] = useState(initial.shuffle);
  const [repeat, setRepeat] = useState<RepeatMode>(initial.repeat);
  // Shuffle order is frozen when shuffle turns on (or a track starts
  // outside it) and reconciled against the visible list per step, so
  // filtering mid-shuffle doesn't reshuffle what's already queued.
  const shuffleOrderRef = useRef<number[]>([]);

  // Refs so stable callbacks (step, engine handlers) read live state.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const currentRef = useRef(current);
  currentRef.current = current;
  const shuffleRef = useRef(shuffle);
  shuffleRef.current = shuffle;
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const frozenShuffleOrder = useCallback(
    () => (shuffleRef.current ? shuffleOrderRef.current : null),
    [],
  );

  /** Sync the UI to a track the engine advanced into (gapless handoff
      or transition), consuming the queue head it may have eaten. */
  const syncAdvancedTrack = useCallback((track: TrackRow) => {
    setCurrent(track);
    setPosition(0);
    setQueue((q) => q.filter((id) => id !== track.id));
    getLyrics(track.path).then(setLyrics).catch(() => setLyrics(null));
    getArtwork(track.path).then((a) => setArtwork(a?.dataUrl ?? null)).catch(() => setArtwork(null));
  }, []);

  const play = useCallback(
    async (track: TrackRow) => {
      onError(null);
      try {
        await engine.play({ path: track.path, replaygainDb: track.replaygain_db });
        setCurrent(track);
        setPaused(false);
        setPosition(0);
        // Companion surfaces load after playback starts; failures there
        // must never interrupt the music.
        getLyrics(track.path).then(setLyrics).catch(() => setLyrics(null));
        getArtwork(track.path).then((a) => setArtwork(a?.dataUrl ?? null)).catch(() => setArtwork(null));
      } catch (e) {
        onError(`${displayTitle(track)}: ${e}`);
      }
    },
    [engine, onError],
  );

  // DJ crossfade arming state (effect below); seekTo voids both.
  const transitionArmed = useRef<string | null>(null);
  const planEpoch = useRef(0);

  const seekTo = useCallback(
    (secs: number) => {
      // Any seek invalidates in-flight and armed transition plans; the
      // position effect re-arms if the new spot still qualifies.
      planEpoch.current++;
      transitionArmed.current = null;
      engine.seek(secs);
      setPosition(secs);
    },
    [engine],
  );

  const togglePause = useCallback(() => {
    engine.togglePause();
    setPaused(engine.paused);
  }, [engine]);

  // Step through the play order (visible listing, or the frozen
  // shuffle permutation). `manual` distinguishes a user skip from a
  // natural track end — repeat-one only replays on natural ends.
  // resolveAdvance owns the queue-vs-order precedence and pruning.
  const step = useCallback(
    (offset: 1 | -1, manual = true) => {
      const list = visibleRef.current;
      const cur = currentRef.current;
      const adv = resolveAdvance(
        list.map((t) => t.id),
        queueRef.current,
        cur?.id ?? null,
        shuffleRef.current ? shuffleOrderRef.current : null,
        repeatRef.current,
        offset,
        manual,
      );
      if (adv.queue !== queueRef.current) setQueue(adv.queue);
      const next = adv.id != null ? list.find((t) => t.id === adv.id) : undefined;
      if (next) {
        if (next.id === cur?.id) {
          // Repeat-one replay: restart instead of reloading the file.
          seekTo(0);
          if (engine.paused) {
            engine.togglePause();
            setPaused(false);
          }
        } else {
          void play(next);
        }
      }
      return Boolean(next);
    },
    [play, seekTo, engine],
  );

  const toggleShuffle = useCallback(() => {
    setShuffle((on) => {
      const next = !on;
      if (next) {
        // Freeze a permutation of what's visible now, current track first.
        shuffleOrderRef.current = shuffledIds(
          visibleRef.current.map((t) => t.id),
          currentRef.current?.id ?? null,
          Math.random,
        );
      }
      return next;
    });
  }, []);

  // Keep the idle deck preloaded with the track a natural end leads to
  // (gapless). "Next" follows the play-next queue first (audit P1),
  // then the play order — shuffle permutation and repeat included
  // (repeat-one preloads the same file for a gapless replay). Beat
  // grids for the current/next pair warm here too (crossfade planning
  // needs both).
  useEffect(() => {
    // Peek (not consume): same resolver as step(), queue changes ignored.
    const adv = resolveAdvance(
      visible.map((t) => t.id),
      queue,
      current?.id ?? null,
      shuffle ? shuffleOrderRef.current : null,
      repeat,
      1,
      false,
    );
    const next = adv.id != null ? visible.find((t) => t.id === adv.id) : undefined;
    engine.preloadNext(next ? { path: next.path, replaygainDb: next.replaygain_db } : null);
    // Warm mix points for the pair (no-op when the sweeper already
    // persisted anchors — planning then reads the index, zero decode).
    // Only while MIX is on: with crossfade off the anchors are never
    // read, and the slow path is a full decode + inference per track.
    if (!crossfadeSec) return;
    if (current) void tailMixPoint(current);
    if (next) void headMixPoint(next);
  }, [engine, visible, current, shuffle, repeat, queue, crossfadeSec]);

  // DJ crossfade: when enabled and the track nears its end, plan a
  // transition from the persisted mix anchors and hand it to the
  // engine. Arming is a revocable reservation, not a one-shot latch:
  // scrubbing out of the end window (or any seek — planEpoch bumps)
  // voids it, and re-entering the window re-plans. Cheap to re-plan:
  // anchors come from the index, not a decode.
  useEffect(() => {
    if (!crossfadeSec || !current) return;
    if (position <= 0 || !Number.isFinite(engine.duration)) return;
    const remaining = engine.duration - position;
    // Lead time: the planned fade plus one beat of slack for planning.
    if (remaining > crossfadeSec + 1) {
      transitionArmed.current = null; // scrubbed back out: void the reservation
      return;
    }
    if (engine.transitioning) return;
    if (transitionArmed.current === current.path) return;
    transitionArmed.current = current.path;
    const epoch = planEpoch.current;

    // "Next" resolves exactly like preload (same resolver, peek only).
    // Repeat-one replays the same file — a crossfade into itself is
    // meaningless, so let the gapless path handle it.
    const adv = resolveAdvance(
      visibleRef.current.map((t) => t.id),
      queueRef.current,
      current.id,
      shuffleRef.current ? shuffleOrderRef.current : null,
      repeatRef.current,
      1,
      false,
    );
    const next =
      adv.id != null && adv.id !== current.id
        ? visibleRef.current.find((t) => t.id === adv.id)
        : undefined;
    if (!next) return;
    void (async () => {
      // Role-correct grids: the outgoing track leaves through its TAIL,
      // the incoming enters through its HEAD. A missing anchor (soflan
      // boundary, rit. ending, beatless, unanalyzed) degrades the plan
      // to a plain equal-power crossfade.
      const [tailOut, headIn] = await Promise.all([
        tailMixPoint(current),
        headMixPoint(next),
      ]);
      // A seek landed while we were planning: the premise (track is
      // ending) may no longer hold — drop this plan; the effect
      // re-arms if the position still (or again) qualifies.
      if (planEpoch.current !== epoch) return;
      const plan = planTransition(tailOut, headIn, crossfadeSec);
      // Engine returns false when the plan is stale (the track changed
      // while anchors were computing — the analysis slow path can take
      // longer than the track's remaining seconds) or the preload isn't
      // ready. Some of those states are transient (buffering catches
      // up within the end window), so void the reservation and let the
      // next position tick retry — cheap, anchors come from the index.
      // If the rejection is permanent the retries keep failing and the
      // track ends naturally: gapless takes over, same as before.
      if (!engine.beginTransition(plan, current.path)) {
        transitionArmed.current = null;
      }
    })();
  }, [position, crossfadeSec, current, engine]);

  useEffect(() => {
    engine.onTransitionAdvance((path) => {
      const track = visibleRef.current.find((t) => t.path === path);
      if (track) syncAdvancedTrack(track);
    });
  }, [engine, syncAdvancedTrack]);

  // Re-arm the transition trigger whenever the playing track changes.
  useEffect(() => {
    transitionArmed.current = null;
  }, [current]);

  useEffect(() => {
    engine.onEnded((advancedTo) => {
      if (advancedTo) {
        // Engine already handed off gaplessly — sync UI state to it.
        const track = visibleRef.current.find((t) => t.path === advancedTo);
        if (track) {
          syncAdvancedTrack(track);
          return;
        }
      }
      // No handoff (repeat off at the edge, or preload miss): step the
      // play order as a natural end; nothing next → stop.
      if (!step(1, false)) setPaused(true);
    });
    engine.onError(onError);
    engine.onTimeUpdate(setPosition);
  }, [engine, step, syncAdvancedTrack, onError]);

  // Live position sampler for Stage's lyric clock loop (audit r5:
  // Stage samples inside its own rAF instead of App re-rendering the
  // whole Stage tree at 60fps through a positionMs state).
  const getPositionMs = useCallback(() => engine.positionMs, [engine]);

  // Engine duration once metadata loads; index duration until then.
  const duration = Number.isFinite(engine.duration)
    ? engine.duration
    : current?.duration_secs ?? NaN;

  return useMemo(
    () => ({
      current,
      paused,
      position,
      lyrics,
      artwork,
      queue,
      setQueue,
      shuffle,
      repeat,
      setRepeat,
      duration,
      frozenShuffleOrder,
      play,
      step,
      toggleShuffle,
      seekTo,
      togglePause,
      getPositionMs,
    }),
    [
      current,
      paused,
      position,
      lyrics,
      artwork,
      queue,
      shuffle,
      repeat,
      duration,
      frozenShuffleOrder,
      play,
      step,
      toggleShuffle,
      seekTo,
      togglePause,
      getPositionMs,
    ],
  );
}
