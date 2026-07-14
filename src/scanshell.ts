// Scan shell: folder-pick + drag-drop library scans (audit P1 / r5
// P1). Owns the scanning flag, the drop-zone affordance, and the
// native drag-drop listener; reports through the toast stack and the
// error slot, then asks App to refresh the table.

import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { scanLibrary } from "./ipc";

export interface ScanShell {
  /** A scan is in flight (disables the scan buttons). */
  scanning: boolean;
  /** A folder is dragged over the window (lights the drop zone). */
  dragOver: boolean;
  /** Folder-picker entry point (toolbar, empty state, menu bar). */
  pickAndScan(): Promise<void>;
}

export function useScan(
  onReport: (text: string) => void,
  onError: (message: string | null) => void,
  refresh: () => void,
): ScanShell {
  const [scanning, setScanning] = useState(false);
  // Drag-over scan affordance (audit r5 P1): full-window drop zone.
  const [dragOver, setDragOver] = useState(false);

  const scanDir = useCallback(
    async (dir: string) => {
      setScanning(true);
      onError(null);
      try {
        const report = await scanLibrary(dir);
        const parts = [`Added ${report.added}, updated ${report.updated}`];
        if (report.skipped_icloud.length > 0) parts.push(`${report.skipped_icloud.length} in iCloud`);
        if (report.unreadable.length > 0) parts.push(`${report.unreadable.length} unreadable`);
        onReport(parts.join(" · "));
        refresh();
      } catch (e) {
        onError(String(e));
      } finally {
        setScanning(false);
      }
    },
    [onReport, onError, refresh],
  );
  const scanDirRef = useRef(scanDir);
  scanDirRef.current = scanDir;

  const pickAndScan = useCallback(async () => {
    const dir = await openDialog({ directory: true });
    if (typeof dir !== "string") return;
    await scanDirRef.current(dir);
  }, []);

  // Drag a folder anywhere onto the window to scan it (audit P1).
  // Tauri delivers native file drops as events (webview drag data has
  // no paths); scanning is idempotent, so over-triggering is safe.
  // enter/over light the drop-zone overlay (audit r5 P1: the feature
  // was invisible without an affordance).
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onDragDropEvent((e) => {
      if (e.payload.type === "drop") {
        setDragOver(false);
        if (e.payload.paths.length > 0) void scanDirRef.current(e.payload.paths[0]);
      } else if (e.payload.type === "leave") {
        setDragOver(false);
      } else {
        setDragOver(true); // enter + over
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  return { scanning, dragOver, pickAndScan };
}
