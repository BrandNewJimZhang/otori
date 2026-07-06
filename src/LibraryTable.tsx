// Backstage library table: sortable headers, selection painting, the
// row-level play affordance, resizable columns, and a live "now
// playing" indicator. Pure presentation — sort/filter/selection state
// lives in App, logic in library.ts, column prefs in prefs.ts.

import { useRef } from "react";
import type { Selection, SortKey, SortSpec } from "./library";
import { displayTitle } from "./library";
import { formatTime } from "./format";
import { PlayIcon } from "./icons";
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
    <table>
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
              {sort?.key === c.key && (
                <span className="sort-arrow">{sort.dir === 1 ? "▲" : "▼"}</span>
              )}
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
