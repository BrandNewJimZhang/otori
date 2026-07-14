// Context-menu construction for the library table: the row menu
// (single vs multi selection, queue add/remove flip) and the header
// column chooser. Pure decision logic — App supplies the doers and
// owns the state they mutate.

import type { MenuItem } from "./ContextMenu";
import { COLUMNS, displayTitle, type SortKey, type SortSpec } from "./library";
import type { TrackRow } from "./types";

export interface TrackMenuActions {
  play(track: TrackRow): void;
  /** Open the inspector on these rows (App also syncs the selection). */
  getInfo(targets: TrackRow[]): void;
  queueAdd(ids: number[]): void;
  queueRemove(ids: number[]): void;
  revealInFinder(path: string): void;
  copyText(text: string): void;
  reanalyze(ids: number[]): void;
}

/** Row context menu; `queue` decides the Play next / Remove flip. */
export function trackMenuItems(
  targets: TrackRow[],
  queue: readonly number[],
  act: TrackMenuActions,
): MenuItem[] {
  if (targets.length === 0) return [];
  const [first] = targets;
  const ids = targets.map((t) => t.id);
  const inQueue = ids.every((id) => queue.includes(id));
  const queueItem: MenuItem = inQueue
    ? {
        label: ids.length === 1 ? "Remove from queue" : `Remove ${ids.length} from queue`,
        action: () => act.queueRemove(ids),
      }
    : {
        label: ids.length === 1 ? "Play next" : `Play ${ids.length} next`,
        action: () => act.queueAdd(ids),
      };
  if (targets.length === 1) {
    return [
      { label: "Play", action: () => act.play(first) },
      {
        // The context menu is the natural "act on this row" surface;
        // ⌘I alone left the inspector undiscoverable (design r2).
        label: "Get Info",
        action: () => act.getInfo(targets),
      },
      queueItem,
      {
        label: "Reveal in Finder",
        separator: true,
        action: () => act.revealInFinder(first.path),
      },
      {
        // user-select:none is deliberate app chrome (P3): copying
        // metadata goes through the menu instead of text selection.
        label: "Copy title – artist",
        separator: true,
        action: () => act.copyText(`${displayTitle(first)} – ${first.artist ?? ""}`.trim()),
      },
      {
        label: "Copy path",
        action: () => act.copyText(first.path),
      },
      {
        label: "Reanalyze BPM",
        separator: true,
        action: () => act.reanalyze(ids),
      },
    ];
  }
  // Multi-selection: batch actions only (play is inherently single).
  return [
    {
      label: `Get Info on ${targets.length} tracks`,
      action: () => act.getInfo(targets),
    },
    queueItem,
    {
      label: `Copy ${targets.length} paths`,
      separator: true,
      action: () => act.copyText(targets.map((t) => t.path).join("\n")),
    },
    {
      label: `Reanalyze BPM (${targets.length})`,
      separator: true,
      action: () => act.reanalyze(ids),
    },
  ];
}

export interface ColumnMenuActions {
  toggle(key: SortKey): void;
  clearSort(): void;
}

/** Header column chooser: one entry per hideable registry column,
    checkmark = currently shown. Hiding the sorted column also clears
    the sort — a sort you can no longer see or cycle is a trap. */
export function columnMenuItems(
  hiddenColumns: readonly SortKey[],
  sort: SortSpec | null,
  act: ColumnMenuActions,
): MenuItem[] {
  return COLUMNS.filter((c) => c.hideable).map((c) => {
    const shown = !hiddenColumns.includes(c.key);
    return {
      label: `${shown ? "✓ " : " "}${c.label}`,
      action: () => {
        if (shown && sort?.key === c.key) act.clearSort();
        act.toggle(c.key);
      },
    };
  });
}
