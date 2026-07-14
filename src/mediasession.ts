// System Now Playing / media keys via the MediaSession API; no-op
// where the WebView doesn't expose it. UI wiring only — the decision
// of what "play/pause/step/seek" mean stays with the caller.

import { useEffect } from "react";
import { displayTitle } from "./library";
import type { PlaybackEngine } from "./playback";
import type { TrackRow } from "./types";

export function useMediaSession(
  engine: PlaybackEngine,
  current: TrackRow | null,
  artwork: string | null,
  position: number,
  togglePause: () => void,
  step: (offset: 1 | -1) => void,
  seekTo: (secs: number) => void,
) {
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.metadata = current
      ? new MediaMetadata({
          title: displayTitle(current),
          artist: current.artist ?? undefined,
          album: current.album ?? undefined,
          artwork: artwork ? [{ src: artwork }] : [],
        })
      : null;
    // Idempotent per system semantics: "play" only resumes, "pause" only pauses.
    ms.setActionHandler("play", () => {
      if (engine.paused) togglePause();
    });
    ms.setActionHandler("pause", () => {
      if (!engine.paused) togglePause();
    });
    ms.setActionHandler("previoustrack", () => step(-1));
    ms.setActionHandler("nexttrack", () => step(1));
    ms.setActionHandler("seekto", (d) => {
      if (d.seekTime != null) seekTo(d.seekTime);
    });
    return () => {
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("previoustrack", null);
      ms.setActionHandler("nexttrack", null);
      ms.setActionHandler("seekto", null);
    };
  }, [current, artwork, togglePause, step, seekTo, engine]);

  // Control Center progress: position/duration at timeupdate cadence.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !current) return;
    if (!Number.isFinite(engine.duration)) return;
    navigator.mediaSession.setPositionState({
      duration: engine.duration,
      position: Math.min(position, engine.duration),
      playbackRate: 1,
    });
  }, [current, position, engine]);
}
