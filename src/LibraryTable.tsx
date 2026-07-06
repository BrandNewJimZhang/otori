// Backstage library table: sortable headers, selection painting, and the
// row-level play affordance. Pure presentation — sort/filter/selection
// state lives in App, logic in library.ts.

import type { Selection, SortKey, SortSpec } from "./library";
import { displayTitle } from "./library";
import { formatTime } from "./format";
import { PlayIcon } from "./icons";
import type { TrackRow } from "./types";

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "duration_secs", label: "Time", className: "col-duration" },
  { key: "format", label: "Format", className: "col-format" },
];

interface Props {
  tracks: TrackRow[];
  playingId: number | null;
  selection: Selection;
  sort: SortSpec | null;
  onSort(key: SortKey): void;
  onRowClick(id: number, mods: { shift: boolean; meta: boolean }): void;
  onRowContextMenu(track: TrackRow, e: React.MouseEvent): void;
  onPlay(track: TrackRow): void;
}

export function LibraryTable({
  tracks,
  playingId,
  selection,
  sort,
  onSort,
  onRowClick,
  onRowContextMenu,
  onPlay,
}: Props) {
  return (
    <table>
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th
              key={c.key}
              className={c.className}
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
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {tracks.map((t) => (
          <tr
            key={t.id}
            className={[
              t.id === playingId ? "playing" : "",
              selection.ids.has(t.id) ? "selected" : "",
            ].join(" ")}
            onClick={(e) => onRowClick(t.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })}
            onDoubleClick={() => onPlay(t)}
            onContextMenu={(e) => onRowContextMenu(t, e)}
          >
            <td>
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
              {displayTitle(t)}
            </td>
            <td>{t.artist ?? "—"}</td>
            <td>{t.album ?? "—"}</td>
            <td className="col-duration">{formatTime(t.duration_secs)}</td>
            <td className="col-format">{t.format}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
