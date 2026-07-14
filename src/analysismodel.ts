// Analysis-model selection orchestration: the download-on-demand
// switch flow (status-bar cycle button + Settings picker) as a pure
// async function over injected effects, so the decision paths —
// no-op guards, direct switch, download-then-switch, download
// failure — are testable without React or the IPC layer.

import type { AnalysisModelInfo } from "./ipc";

export interface ModelSelectEffects {
  /** IPC: switch the shell's active model + reopen foreign verdicts. */
  switchModel(id: string): Promise<unknown>;
  /** IPC: fetch + checksum-verify unbundled weights. */
  downloadModel(id: string): Promise<unknown>;
  /** Persist the new id and restart the sweep under it. */
  onSwitched(id: string): void;
  onError(message: string): void;
  toast(text: string): void;
}

/**
 * Select a registered model, downloading its weights first when absent.
 * Returns false when the request is a no-op (already active, unknown id,
 * or a switch already in flight — the caller passes `switching`).
 * A download/checksum failure is a toast, not a silent skip: the user
 * asked for the model and nothing happened.
 */
export async function performModelSelect(
  fx: ModelSelectEffects,
  id: string,
  models: AnalysisModelInfo[],
  activeId: string,
  switching: boolean,
): Promise<boolean> {
  const next = models.find((m) => m.id === id);
  if (switching || !next || next.id === activeId) return false;
  if (!next.available) {
    fx.toast(`Downloading ${next.label} model…`);
    try {
      await fx.downloadModel(next.id);
    } catch (e) {
      fx.toast(`${next.label} download failed: ${String(e)}`);
      return true; // the attempt ran (and surfaced); the caller resets `switching`
    }
  }
  try {
    await fx.switchModel(next.id);
    fx.onSwitched(next.id);
  } catch (e) {
    fx.onError(String(e));
  }
  return true;
}

/** The id the status-bar cycle button moves to (next in registry
    order, wrapping), or null when there's nothing to cycle to. */
export function nextModelId(models: AnalysisModelInfo[], activeId: string): string | null {
  if (models.length === 0) return null;
  const idx = models.findIndex((m) => m.id === activeId);
  return models[(idx + 1) % models.length].id;
}
