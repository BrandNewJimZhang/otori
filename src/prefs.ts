// UI preference persistence (audit P1: volume/sort reset on every
// launch). localStorage is a preference cache, not authoritative data —
// invalid blobs fall back to defaults instead of failing fast.

import type { SortSpec } from "./library";
import type { ColumnWidths } from "./LibraryTable";
import type { RepeatMode } from "./playorder";

/** "auto" follows the macOS system appearance (audit r5 P2). */
export type Theme = "dark" | "light" | "auto";
export type Density = "comfortable" | "compact";

/**
 * Selectable Beat This! analysis models. The id is the SSOT string the
 * index stamps into `analysis_model`; the Rust registry
 * (`crates/otori-analysis/src/models.rs`) is the authority for the
 * valid set — this is the allowlist that survives a corrupt pref
 * without poisoning the rest. Add a model here AND in the Rust
 * registry together.
 */
export type AnalysisModel = "small" | "standard";

export interface Prefs {
  volume: number;
  sort: SortSpec | null;
  shuffle: boolean;
  repeat: RepeatMode;
  theme: Theme;
  /** Crossfade seconds; 0 = gapless handoff (no fade). */
  crossfadeSec: number;
  /** Table row density. */
  density: Density;
  /** User-dragged column widths in px; missing = auto layout. */
  columnWidths: ColumnWidths;
  /** Which beat model the sweep runs. */
  analysisModel: AnalysisModel;
}

const KEY = "otori.prefs";
const DEFAULTS: Prefs = {
  volume: 1,
  sort: null,
  shuffle: false,
  repeat: "off",
  theme: "dark",
  crossfadeSec: 0,
  density: "comfortable",
  columnWidths: {},
  analysisModel: "small",
};
const SORT_KEYS = new Set(["title", "artist", "album", "duration_secs", "bpm", "format"]);
const REPEAT_MODES = new Set<RepeatMode>(["off", "all", "one"]);
const THEMES = new Set<Theme>(["dark", "light", "auto"]);
const CROSSFADE_MAX_SEC = 30;
const DENSITIES = new Set<Density>(["comfortable", "compact"]);
const ANALYSIS_MODELS = new Set<AnalysisModel>(["small", "standard"]);

export function loadPrefs(storage: Storage): Prefs {
  const raw = storage.getItem(KEY);
  if (raw == null) return DEFAULTS;
  try {
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
    const volumeOk = typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1;
    const sortOk =
      p.sort === null || (SORT_KEYS.has(p.sort?.key) && (p.sort?.dir === 1 || p.sort?.dir === -1));
    const modesOk =
      typeof p.shuffle === "boolean" && REPEAT_MODES.has(p.repeat) && THEMES.has(p.theme);
    if (!volumeOk || !sortOk || !modesOk) return DEFAULTS;
    // crossfadeSec spreads from DEFAULTS when missing; out-of-range
    // falls back to 0 without dropping the rest.
    const crossfadeSec =
      typeof p.crossfadeSec === "number" && p.crossfadeSec >= 0 && p.crossfadeSec <= CROSSFADE_MAX_SEC
        ? p.crossfadeSec
        : 0;
    // Later-arrival prefs degrade individually, never poisoning the rest.
    const density = DENSITIES.has(p.density) ? p.density : "comfortable";
    const columnWidths =
      p.columnWidths != null &&
      typeof p.columnWidths === "object" &&
      Object.values(p.columnWidths).every((w) => typeof w === "number" && w > 0)
        ? p.columnWidths
        : {};
    const analysisModel = ANALYSIS_MODELS.has(p.analysisModel) ? p.analysisModel : "small";
    return {
      volume: p.volume,
      sort: p.sort,
      shuffle: p.shuffle,
      repeat: p.repeat,
      theme: p.theme,
      crossfadeSec,
      density,
      columnWidths,
      analysisModel,
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(storage: Storage, prefs: Prefs): void {
  storage.setItem(KEY, JSON.stringify(prefs));
}
