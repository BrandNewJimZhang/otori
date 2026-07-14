// Prefs shell: owns the preference state App renders with (volume,
// theme, crossfade, density, column widths/visibility, sort) and the
// effect that persists the assembled Prefs blob. Two hooks because of
// hook-order: playbackshell needs crossfadeSec (state, called first),
// while the blob needs shuffle/repeat back from playbackshell (effect,
// called last). Load/save and validation stay in prefs.ts (SSOT).

import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ColumnWidths } from "./LibraryTable";
import type { SortKey, SortSpec } from "./library";
import { savePrefs, type Density, type Prefs, type Theme } from "./prefs";

export interface PrefsShell {
  volume: number;
  setVolume: Dispatch<SetStateAction<number>>;
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
  crossfadeSec: number;
  setCrossfadeSec: Dispatch<SetStateAction<number>>;
  density: Density;
  setDensity: Dispatch<SetStateAction<Density>>;
  columnWidths: ColumnWidths;
  setColumnWidths: Dispatch<SetStateAction<ColumnWidths>>;
  hiddenColumns: readonly SortKey[];
  setHiddenColumns: Dispatch<SetStateAction<readonly SortKey[]>>;
  sort: SortSpec | null;
  setSort: Dispatch<SetStateAction<SortSpec | null>>;
}

export function usePrefs(initial: Prefs): PrefsShell {
  const [volume, setVolume] = useState(initial.volume);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [crossfadeSec, setCrossfadeSec] = useState(initial.crossfadeSec);
  const [density, setDensity] = useState<Density>(initial.density);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(initial.columnWidths);
  // Columns hidden via the header context menu; persisted like widths.
  const [hiddenColumns, setHiddenColumns] = useState<readonly SortKey[]>(initial.hiddenColumns);
  const [sort, setSort] = useState<SortSpec | null>(initial.sort);

  return {
    volume,
    setVolume,
    theme,
    setTheme,
    crossfadeSec,
    setCrossfadeSec,
    density,
    setDensity,
    columnWidths,
    setColumnWidths,
    hiddenColumns,
    setHiddenColumns,
    sort,
    setSort,
  };
}

/** Persist the assembled blob whenever any field changes. App composes
    it from the prefs shell plus the fields other shells own (shuffle/
    repeat, analysisModel). */
export function useSavePrefs(prefs: Prefs): void {
  const { volume, sort, shuffle, repeat, theme, crossfadeSec, density, columnWidths, hiddenColumns, analysisModel } = prefs;
  useEffect(() => {
    savePrefs(localStorage, {
      volume,
      sort,
      shuffle,
      repeat,
      theme,
      crossfadeSec,
      density,
      columnWidths,
      hiddenColumns,
      analysisModel,
    });
  }, [volume, sort, shuffle, repeat, theme, crossfadeSec, density, columnWidths, hiddenColumns, analysisModel]);
}
