// Backstage header: brand, scan, search, and the toggle cluster.
// Pure presentation — every knob's state lives in App; this renders
// props and dispatches callbacks (same status as LibraryTable/Stage).

import type { RefObject } from "react";
import type { AnalysisModelInfo } from "./ipc";
import type { AnalysisModel, Density, Theme } from "./prefs";
import {
  AutoThemeIcon,
  BrandMark,
  DensityIcon,
  GearIcon,
  InfoIcon,
  MetronomeIcon,
  MoonIcon,
  StageIcon,
  SunIcon,
} from "./icons";

interface Props {
  /** Hides the traffic-light padding when the window is fullscreen. */
  fullscreen: boolean;
  scanning: boolean;
  query: string;
  visibleCount: number;
  trackCount: number;
  /** ⌘F focuses this input (App routes the keyboard). */
  searchRef: RefObject<HTMLInputElement | null>;
  canStage: boolean;
  inspectorOpen: boolean;
  density: Density;
  theme: Theme;
  analysisModel: AnalysisModel;
  analysisModels: AnalysisModelInfo[];
  analysisSwitching: boolean;
  settingsOpen: boolean;
  onScan(): void;
  onQuery(q: string): void;
  onEnterStage(): void;
  onToggleInspector(): void;
  onToggleDensity(): void;
  onCycleTheme(): void;
  onCycleAnalysisModel(): void;
  onToggleSettings(): void;
}

export function Toolbar({
  fullscreen,
  scanning,
  query,
  visibleCount,
  trackCount,
  searchRef,
  canStage,
  inspectorOpen,
  density,
  theme,
  analysisModel,
  analysisModels,
  analysisSwitching,
  settingsOpen,
  onScan,
  onQuery,
  onEnterStage,
  onToggleInspector,
  onToggleDensity,
  onCycleTheme,
  onCycleAnalysisModel,
  onToggleSettings,
}: Props) {
  return (
    <header className={`toolbar ${fullscreen ? "fullscreen" : ""}`} data-tauri-drag-region>
      <h1 className="brand">
        <BrandMark />
        Ōtori
      </h1>
      <button onClick={onScan} disabled={scanning}>
        {scanning ? "Scanning…" : "Scan folder…"}
      </button>
      <input
        ref={searchRef}
        className="search"
        type="search"
        placeholder="Filter (⌘F)"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <span className="track-count">
        {query ? `${visibleCount} / ${trackCount} tracks` : `${trackCount} tracks`}
      </span>
      <button
        className="icon-btn stage-toggle"
        onClick={onEnterStage}
        disabled={!canStage}
        aria-label="Enter Stage mode"
        data-tip={canStage ? "Stage (S)" : "Play a track to enter Stage"}
      >
        <StageIcon />
      </button>
      <button
        className="icon-btn inspector-toggle"
        onClick={onToggleInspector}
        aria-label="Toggle inspector"
        aria-pressed={inspectorOpen}
        data-tip="Inspector (⌘I)"
      >
        <InfoIcon />
      </button>
      <button
        className="icon-btn density-toggle"
        onClick={onToggleDensity}
        aria-label={density === "comfortable" ? "Compact rows" : "Comfortable rows"}
        data-tip={density === "comfortable" ? "Compact rows" : "Comfortable rows"}
      >
        <DensityIcon compact={density === "compact"} />
      </button>
      <button
        className="icon-btn theme-toggle"
        onClick={onCycleTheme}
        aria-label={`Theme: ${theme}`}
        data-tip={
          theme === "dark" ? "Theme: dark" : theme === "light" ? "Theme: light" : "Theme: auto"
        }
      >
        {theme === "dark" ? <MoonIcon /> : theme === "light" ? <SunIcon /> : <AutoThemeIcon />}
      </button>
      <button
        className="icon-btn model-toggle"
        onClick={onCycleAnalysisModel}
        disabled={analysisSwitching || analysisModels.length < 2}
        aria-label={`Analysis model: ${analysisModel}`}
        data-tip={
          analysisModels.length < 2
            ? "Analysis model"
            : `Analysis model: ${analysisModel}${
                analysisModels.find((m) => m.id !== analysisModel && !m.available)
                  ? " · click to download Standard"
                  : ""
              }`
        }
        aria-pressed={analysisModel !== "small"}
      >
        <MetronomeIcon />
      </button>
      <button
        className="icon-btn settings-toggle"
        onClick={onToggleSettings}
        aria-label="Settings"
        aria-pressed={settingsOpen}
        data-tip="Settings (⌘,)"
      >
        <GearIcon />
      </button>
    </header>
  );
}
