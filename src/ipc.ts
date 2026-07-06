// Typed IPC surface — the only place `invoke` is called (SSOT for the
// frontend↔shell contract).

import { invoke } from "@tauri-apps/api/core";
import type { ScanReport, TrackRow } from "./types";

export function scanLibrary(dir: string): Promise<ScanReport> {
  return invoke<ScanReport>("scan_library", { dir });
}

export function listTracks(): Promise<TrackRow[]> {
  return invoke<TrackRow[]>("list_tracks");
}
