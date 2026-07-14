// Shell integration bridges, main-window half (shell side: src-tauri):
// tray menu labels, the tray mini panel's now-playing broadcast, and
// inbound tray/mini-panel commands. Failures are cosmetic and must
// never touch playback.

import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { updateTray } from "./ipc";
import { displayTitle } from "./library";
import { buildNpState } from "./npstate";
import type { PlaybackEngine } from "./playback";
import type { TrackRow } from "./types";

export interface ShellBridgeHandlers {
  /** Mini panel seek commit (one per release). Must be referentially
      stable — the subscription mounts once. */
  onMiniSeek(secs: number): void;
  /** Tray menu click: "playpause" | "next" | "prev". */
  onTrayCommand(cmd: string): void;
}

export function useShellBridge(
  engine: PlaybackEngine,
  current: TrackRow | null,
  paused: boolean,
  artwork: string | null,
  position: number,
  handlers: ShellBridgeHandlers,
) {
  // Status-bar (tray) menu, UI half: mirror playback state into the
  // menu labels.
  useEffect(() => {
    updateTray(current ? displayTitle(current) : null, paused).catch(() => {});
  }, [current, paused]);

  // Tray mini panel: broadcast the now-playing snapshot on every change
  // and whenever the panel asks (np-refresh, emitted by the shell on
  // panel open). Positions ride the separate np-pos event at timeupdate
  // cadence so artwork isn't re-sent per tick.
  useEffect(() => {
    // Engine duration once metadata loads; index duration until then
    // (same fallback as the seek bar).
    const durationSecs = Number.isFinite(engine.duration)
      ? engine.duration
      : current?.duration_secs ?? NaN;
    const state = buildNpState(current, paused, artwork, durationSecs);
    void emit("np-state", state);
    const unlisten = listen("np-refresh", () => {
      void emit("np-state", state);
      void emit("np-pos", engine.currentTime);
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [current, paused, artwork, engine]);

  useEffect(() => {
    if (current) void emit("np-pos", position);
  }, [current, position]);

  // Mini panel seek commits arrive as `mini-seek` (scrub previews stay
  // local to the panel). The handler closes over stable refs only, so
  // a mount-once subscription stays correct.
  const { onMiniSeek, onTrayCommand } = handlers;
  useEffect(() => {
    const unlisten = listen<number>("mini-seek", (e) => onMiniSeek(e.payload));
    return () => {
      unlisten.then((off) => off());
    };
  }, [onMiniSeek]);

  // Tray menu clicks arrive as a `tray-command` event. Same handlers
  // as the on-screen transport.
  useEffect(() => {
    const unlisten = listen<string>("tray-command", (e) => onTrayCommand(e.payload));
    return () => {
      unlisten.then((off) => off());
    };
  }, [onTrayCommand]);
}
