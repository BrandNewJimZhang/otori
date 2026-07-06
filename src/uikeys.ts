// Keyboard routing (audit P0): one pure decision table for "who owns
// this keypress", so global shortcuts can't fight the focus system.
// Zones: "input" (text field focused), "button" (button focused, keeps
// native Enter/Space activation), "global" (everything else). App.tsx
// classifies the event target and executes the returned action.

export interface KeyCombo {
  key: string;
  /** ⌘ on macOS or Ctrl elsewhere. */
  meta: boolean;
  shift: boolean;
}

export type KeyZone = "global" | "input" | "button" | "slider";

export type KeyAction =
  | { kind: "native" } // let the browser/focused element handle it
  | { kind: "focus-search" }
  | { kind: "blur-input" }
  | { kind: "toggle-mode" }
  | { kind: "toggle-pause" }
  | { kind: "select-step"; offset: 1 | -1; extend: boolean }
  | { kind: "select-all" }
  | { kind: "select-edge"; edge: "first" | "last" }
  | { kind: "select-page"; offset: 1 | -1 }
  | { kind: "type-ahead"; char: string }
  | { kind: "play-selected" }
  | { kind: "seek-nudge"; secs: number }
  | { kind: "step-track"; offset: 1 | -1 }
  | { kind: "show-shortcuts" }
  | { kind: "escape" };

const SEEK_NUDGE_SEC = 5;

/** Which UI surface is on screen; Stage has no table, so table keys go inert. */
export type Surface = "backstage" | "stage";

/**
 * Esc priority ladder: exit Stage > clear the Backstage selection >
 * nothing. In Stage a leftover Backstage selection is invisible, so it
 * must never eat the exit press (the hint promises "Esc → Backstage").
 */
export function escapeIntent(
  surface: Surface,
  hasSelection: boolean,
): "exit-stage" | "clear-selection" | "none" {
  if (surface === "stage") return "exit-stage";
  return hasSelection ? "clear-selection" : "none";
}

/** Actions that operate the Backstage table — meaningless while it's hidden. */
const TABLE_ACTIONS = new Set<KeyAction["kind"]>([
  "focus-search",
  "select-step",
  "select-all",
  "select-edge",
  "select-page",
  "type-ahead",
  "play-selected",
]);

export function routeKey(combo: KeyCombo, zone: KeyZone, surface: Surface = "backstage"): KeyAction {
  const action = routeKeyBackstage(combo, zone);
  // Stage shows no table: selection/search/type-ahead keys must not
  // reach the hidden Backstage state (audit R4 — Enter used to play
  // an invisibly selected row mid-performance).
  if (surface === "stage" && TABLE_ACTIONS.has(action.kind)) return { kind: "native" };
  return action;
}

function routeKeyBackstage(combo: KeyCombo, zone: KeyZone): KeyAction {
  // ⌘F reaches search from anywhere, including inside inputs.
  if (combo.meta && combo.key.toLowerCase() === "f") return { kind: "focus-search" };
  // ⌘←/→ = previous/next track (Music.app convention) — but inside an
  // input those chords are line home/end, which the field keeps.
  if (combo.meta && zone !== "input" && combo.key === "ArrowRight") {
    return { kind: "step-track", offset: 1 };
  }
  if (combo.meta && zone !== "input" && combo.key === "ArrowLeft") {
    return { kind: "step-track", offset: -1 };
  }
  // ⌘A selects all visible rows outside text fields.
  if (combo.meta && zone !== "input" && combo.key.toLowerCase() === "a") {
    return { kind: "select-all" };
  }
  // Other ⌘-chords are the system's (⌘Q, ⌘W, ⌘C…).
  if (combo.meta) return { kind: "native" };

  if (zone === "input") {
    return combo.key === "Escape" ? { kind: "blur-input" } : { kind: "native" };
  }

  // A focused button keeps its native activation keys (audit P0: Space
  // used to hijack activation into play/pause, Enter double-fired).
  if (zone === "button" && (combo.key === "Enter" || combo.key === " ")) {
    return { kind: "native" };
  }

  // A focused range slider owns its arrow keys (native nudge).
  if (zone === "slider" && combo.key.startsWith("Arrow")) {
    return { kind: "native" };
  }

  switch (combo.key) {
    case "s":
    case "S": // CapsLock must not disable the toggle (audit P3)
      // Shift+S is deliberate typing, not the mode toggle — but only
      // when it could reach type-ahead below; keep the plain toggle.
      return combo.shift ? { kind: "type-ahead", char: combo.key } : { kind: "toggle-mode" };
    case " ":
      return { kind: "toggle-pause" };
    case "ArrowDown":
      return { kind: "select-step", offset: 1, extend: combo.shift };
    case "ArrowUp":
      return { kind: "select-step", offset: -1, extend: combo.shift };
    case "ArrowRight":
      return { kind: "seek-nudge", secs: SEEK_NUDGE_SEC };
    case "ArrowLeft":
      return { kind: "seek-nudge", secs: -SEEK_NUDGE_SEC };
    case "Home":
      return { kind: "select-edge", edge: "first" };
    case "End":
      return { kind: "select-edge", edge: "last" };
    case "PageDown":
      return { kind: "select-page", offset: 1 };
    case "PageUp":
      return { kind: "select-page", offset: -1 };
    case "Enter":
      return { kind: "play-selected" };
    case "Escape":
      return { kind: "escape" };
    case "?":
      // Shortcuts overlay (audit r5 P2): the deep keyboard model needs
      // a discoverable index; "?" beats a track-title type-ahead edge.
      return { kind: "show-shortcuts" };
    default:
      // Printable characters feed table type-ahead (Finder-style).
      if (combo.key.length === 1 && /\S/.test(combo.key)) {
        return { kind: "type-ahead", char: combo.key };
      }
      return { kind: "native" };
  }
}
