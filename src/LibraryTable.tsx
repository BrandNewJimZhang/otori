// Backstage library table: sortable headers, selection painting, the
// row-level play affordance, resizable columns, and a live "now
// playing" indicator. Pure presentation — sort/filter/selection state
// lives in App, logic in library.ts, column prefs in prefs.ts.

import { useEffect, useRef } from "react";
import type { Selection, SortKey, SortSpec } from "./library";
import { displayTitle } from "./library";
import { formatTime } from "./format";
import { PlayIcon, SortArrowIcon } from "./icons";
import type { TrackRow } from "./types";

const COLUMNS: { key: SortKey; label: string; className?: string; resizable?: boolean }[] = [
  { key: "title", label: "Title", resizable: true },
  { key: "artist", label: "Artist", resizable: true },
  { key: "album", label: "Album", resizable: true },
  { key: "duration_secs", label: "Time", className: "col-duration" },
  { key: "bpm", label: "BPM", className: "col-bpm" },
  { key: "format", label: "Format", className: "col-format" },
];

export type ColumnWidths = Partial<Record<SortKey, number>>;

const MIN_COL_PX = 80;

interface Props {
  tracks: TrackRow[];
  playingId: number | null;
  /** Playing-row indicator animates only while sound is coming out. */
  paused: boolean;
  /** Track id → 1-based play-next queue position (badge in the title cell). */
  queuePositions: ReadonlyMap<number, number>;
  selection: Selection;
  sort: SortSpec | null;
  columnWidths: ColumnWidths;
  onColumnWidths(widths: ColumnWidths): void;
  onSort(key: SortKey): void;
  onRowClick(id: number, mods: { shift: boolean; meta: boolean }): void;
  onRowContextMenu(track: TrackRow, e: React.MouseEvent): void;
  onPlay(track: TrackRow): void;
}

/** BPM cell: verified tempo, a min–max range (variable/soflan), an
    unverified hint ("≈185"), or "—". */
function formatBpm(t: TrackRow): string {
  if (t.bpm != null) {
    if (t.bpm_max != null) return `${Math.round(t.bpm)}–${Math.round(t.bpm_max)}`;
    return t.bpm.toFixed(1);
  }
  if (t.bpm_hint != null) return `≈${Math.round(t.bpm_hint)}`;
  return "—";
}

/** Three animated bars; freezes when paused (CSS drives the motion). */
function NowPlayingBars({ paused }: { paused: boolean }) {
  return (
    <span className={`np-bars ${paused ? "paused" : ""}`} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

export function LibraryTable({
  tracks,
  playingId,
  paused,
  queuePositions,
  selection,
  sort,
  columnWidths,
  onColumnWidths,
  onSort,
  onRowClick,
  onRowContextMenu,
  onPlay,
}: Props) {
  const dragRef = useRef<{ key: SortKey; startX: number; startW: number } | null>(null);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());

  // Keyboard selection must stay visible (audit P0): when the anchor
  // moves, bring its row into view. block:"nearest" is a no-op for
  // rows already on screen, so click selection never causes a jump.
  useEffect(() => {
    if (selection.anchor == null) return;
    rowRefs.current.get(selection.anchor)?.scrollIntoView({ block: "nearest" });
  }, [selection.anchor]);

  function beginResize(key: SortKey, e: React.PointerEvent<HTMLSpanElement>) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.target as HTMLElement).closest("th");
    if (!th) return;
    dragRef.current = { key, startX: e.clientX, startW: th.getBoundingClientRect().width };
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const w = Math.max(MIN_COL_PX, Math.round(drag.startW + ev.clientX - drag.startX));
      onColumnWidths({ ...columnWidths, [drag.key]: w });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    // role="grid": <table> alone doesn't permit aria-selected on rows
    // (audit P3); the table is an interactive multiselect listing.
    <table role="grid" aria-multiselectable="true">
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th
              key={c.key}
              className={c.className}
              style={c.resizable && columnWidths[c.key] ? { width: columnWidths[c.key] } : undefined}
              tabIndex={0}
              aria-sort={
                sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined
              }
              onClick={() => onSort(c.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSort(c.key);
                }
              }}
            >
              {c.label}
              {/* Always-rendered slot: the arrow appearing must not
                  shift the label (audit P2 layout jitter). SVG, not
                  ▲▼ text glyphs (audit r5 P3: font-fallback drift). */}
              <span className="sort-arrow">
                {sort?.key === c.key && <SortArrowIcon dir={sort.dir} />}
              </span>
              {c.resizable && (
                <span
                  className="col-resize"
                  onPointerDown={(e) => beginResize(c.key, e)}
                  onClick={(e) => e.stopPropagation()}
                  aria-hidden
                />
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {tracks.map((t) => {
          const playing = t.id === playingId;
          const selected = selection.ids.has(t.id);
          return (
            <tr
              key={t.id}
              ref={(el) => {
                if (el) rowRefs.current.set(t.id, el);
                else rowRefs.current.delete(t.id);
              }}
              className={[playing ? "playing" : "", selected ? "selected" : ""].join(" ")}
              tabIndex={-1}
              aria-selected={selected}
              onClick={(e) => onRowClick(t.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })}
              onDoubleClick={() => onPlay(t)}
              onContextMenu={(e) => onRowContextMenu(t, e)}
            >
              <td>
                {playing ? (
                  <NowPlayingBars paused={paused} />
                ) : (
                  <span
                    className="row-play"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPlay(t);
                    }}
                    aria-label="Play"
                  >
                    <PlayIcon />
                  </span>
                )}
                {displayTitle(t)}
                {queuePositions.has(t.id) && (
                  <span className="queue-badge" title={`Playing next (#${queuePositions.get(t.id)})`}>
                    {queuePositions.get(t.id)}
                  </span>
                )}
              </td>
              <td>{t.artist ?? "—"}</td>
              <td>{t.album ?? "—"}</td>
              <td className="col-duration">{formatTime(t.duration_secs)}</td>
              <td
                className={`col-bpm ${
                  (t.bpm != null && (t.bpm_confidence ?? 0) < 0.4) ||
                  (t.bpm == null && t.bpm_hint != null)
                    ? "low-confidence"
                    : ""
                }`}
                title={
                  t.bpm != null && t.bpm_confidence != null
                    ? `confidence ${(t.bpm_confidence * 100).toFixed(0)}%`
                    : t.bpm_hint != null
                      ? "external value, not yet verified by analysis"
                      : undefined
                }
              >
                {formatBpm(t)}
              </td>
              <td className="col-format">{t.format}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
