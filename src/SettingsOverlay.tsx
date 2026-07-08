// Settings overlay (⌘,): one discoverable home for the scattered
// preference switches. The status-bar toggles stay as shortcuts; state
// lives in App + prefs.ts — this is a controlled surface, no second
// persistence layer.

import { useEffect, useRef } from "react";
import type { AnalysisModelInfo } from "./ipc";
import type { AnalysisModel, Density, Theme } from "./prefs";
import { CROSSFADE_SLIDER_MAX, crossfadeFromSlider } from "./settings";
import { sliderFill } from "./seekbar";

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "auto", label: "Auto" },
];

const DENSITY_OPTIONS: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

interface SettingsOverlayProps {
  theme: Theme;
  onTheme: (t: Theme) => void;
  density: Density;
  onDensity: (d: Density) => void;
  crossfadeSec: number;
  onCrossfadeSec: (secs: number) => void;
  analysisModel: AnalysisModel;
  analysisModels: AnalysisModelInfo[];
  analysisSwitching: boolean;
  /** Switch (downloading first if needed) — App owns the IPC flow. */
  onSelectAnalysisModel: (id: string) => void;
  onClose: () => void;
}

export function SettingsOverlay({
  theme,
  onTheme,
  density,
  onDensity,
  crossfadeSec,
  onCrossfadeSec,
  analysisModel,
  analysisModels,
  analysisSwitching,
  onSelectAnalysisModel,
  onClose,
}: SettingsOverlayProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Modal semantics mirror ShortcutsOverlay: focus moves in on open and
  // returns on close; Escape (or ⌘, again) dismisses; capture phase
  // outruns the app-level key router. Other keys pass through so the
  // segmented buttons and the slider keep native keyboard behavior.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "," && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className="shortcuts-overlay" onMouseDown={onClose}>
      <div
        className="shortcuts-card settings-card"
        ref={cardRef}
        role="dialog"
        aria-label="Settings"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Settings</h2>

        <h3>Appearance</h3>
        <div className="settings-row">
          <span className="settings-label">Theme</span>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={theme === o.value}
                className={theme === o.value ? "on" : ""}
                onClick={() => onTheme(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">Row density</span>
          <div className="segmented" role="radiogroup" aria-label="Row density">
            {DENSITY_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={density === o.value}
                className={density === o.value ? "on" : ""}
                onClick={() => onDensity(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <h3>Playback</h3>
        <div className="settings-row">
          <span className="settings-label">
            DJ crossfade
            <span className="settings-value">
              {crossfadeSec ? `${crossfadeSec}s` : "off (gapless)"}
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={CROSSFADE_SLIDER_MAX}
            step={1}
            value={crossfadeSec}
            style={{ "--fill": sliderFill(crossfadeSec, CROSSFADE_SLIDER_MAX) } as React.CSSProperties}
            onChange={(e) => onCrossfadeSec(crossfadeFromSlider(Number(e.target.value)))}
            aria-label="Crossfade length"
          />
        </div>
        <p className="settings-hint">Beat-matched when tempos allow; 0 keeps gapless handoff.</p>

        <h3>Analysis</h3>
        <div className="settings-row">
          <span className="settings-label">Beat model</span>
          <div className="segmented" role="radiogroup" aria-label="Beat model">
            {analysisModels.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={analysisModel === m.id}
                className={analysisModel === m.id ? "on" : ""}
                disabled={analysisSwitching}
                onClick={() => {
                  if (m.id !== analysisModel) onSelectAnalysisModel(m.id);
                }}
              >
                {m.label}
                {!m.available && " ↓"}
              </button>
            ))}
          </div>
        </div>
        <p className="settings-hint">
          {analysisSwitching
            ? "Switching model…"
            : "↓ marks a model that downloads on first use; switching re-analyzes affected tracks."}
        </p>
      </div>
    </div>
  );
}
