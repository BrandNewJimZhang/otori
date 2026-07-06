// Minimal custom context menu for library rows. One consumer (the
// track table); grows into a shared component only if a second appears.

import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  action(): void;
  /** Draw a group separator above this item (audit r5 P1). */
  separator?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Keyboard menu semantics (audit P3): focus moves into the menu on
  // open and returns on close; ↑↓ wrap through items; Enter/Space
  // activate (native button behavior once focused).
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector("button")?.focus();
    return () => previous?.focus();
  }, []);

  // Any click outside, Escape, or window blur dismisses.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // dismiss the menu only, not the selection
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation(); // arrows navigate the menu, not the table
        const buttons = [...(ref.current?.querySelectorAll("button") ?? [])];
        if (buttons.length === 0) return;
        const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          e.key === "ArrowDown"
            ? (idx + 1) % buttons.length
            : (idx - 1 + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    // Capture phase: outrun the app-level keydown router.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Keep the menu inside the viewport (flip up/left near edges).
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 180),
    top: Math.min(y, window.innerHeight - items.length * 30 - 12),
  };

  return (
    <div className="context-menu" ref={ref} style={style} role="menu">
      {items.map((item) => (
        <div key={item.label} className={item.separator ? "menu-group" : undefined}>
          <button
            role="menuitem"
            onClick={() => {
              item.action();
              onClose();
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
