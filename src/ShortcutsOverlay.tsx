// Shortcuts overlay (audit r5 P2): the keyboard model runs deep
// (type-ahead, ranges, per-zone routing) but had no index; "?" opens
// this card. Static content mirroring uikeys.ts — update both when
// a binding changes.

import { Fragment, useEffect, useRef } from "react";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Playback",
    rows: [
      ["Space", "Play / pause"],
      ["⌘←  ⌘→", "Previous / next track"],
      ["←  →", "Seek ±5s"],
      ["Enter", "Play selected track"],
    ],
  },
  {
    title: "Library",
    rows: [
      ["⌘F", "Filter"],
      ["↑ ↓", "Move selection (⇧ extends)"],
      ["Home / End", "First / last track"],
      ["PgUp / PgDn", "Page through the list"],
      ["⌘A", "Select all"],
      ["⌘I", "Tag inspector"],
      ["⌘,", "Settings"],
      ["a–z …", "Type-ahead jump"],
      ["Esc", "Clear selection"],
    ],
  },
  {
    title: "Stage",
    rows: [
      ["S", "Enter / leave Stage"],
      ["[  ]", "Lyric sync −/+ 100ms"],
      ["Esc", "Back to Backstage"],
    ],
  },
];

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Modal semantics: focus moves in on open, returns on close; Escape
  // and any click outside the card dismiss. Capture phase outruns the
  // app-level key router (same pattern as ContextMenu).
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape" || e.key === "?") {
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
        className="shortcuts-card"
        ref={cardRef}
        role="dialog"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Keyboard shortcuts</h2>
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h3>{g.title}</h3>
            <div className="shortcuts-grid">
              {g.rows.map(([keys, what]) => (
                <Fragment key={keys}>
                  <kbd>{keys}</kbd>
                  <span>{what}</span>
                </Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
