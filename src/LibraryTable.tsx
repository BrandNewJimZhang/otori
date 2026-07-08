// Backstage library table: sortable headers, selection painting, the
// row-level play affordance, resizable columns, and a live "now
// playing" indicator. Pure presentation — sort/filter/selection state
// lives in App, logic in library.ts, column prefs in prefs.ts.

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { Selection, SortKey, SortSpec } from "./library";
import { displayTitle, formatBpm, visibleColumns } from "./library";
import { formatDate, formatDateTime, formatTime } from "./format";
import { NoteIcon, PlayIcon, SortArrowIcon } from "./icons";
import type { ArtworkCache } from "./artworkcache";
import type { TrackRow } from "./types";
import { revealOffset, rowWindow } from "./virtualwindow";

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
  /** Columns hidden via the header context menu (library.ts COLUMNS registry). */
  hiddenColumns: readonly SortKey[];
  /** Lazy cover-art source; the table fetches only rows scrolled into view. */
  artwork: ArtworkCache;
  onColumnWidths(widths: ColumnWidths): void;
  onSort(key: SortKey): void;
  onRowClick(id: number, mods: { shift: boolean; meta: boolean }): void;
  onRowContextMenu(track: TrackRow, e: React.MouseEvent): void;
  /** Right-click on the header row: App opens the column chooser. */
  onHeaderContextMenu(e: React.MouseEvent): void;
  onPlay(track: TrackRow): void;
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

/**
 * Row-leading cover thumbnail: the cover once loaded, a note glyph when
 * the file has none, and — while nothing has resolved — a plain tile so
 * the row height never shifts when the image lands. It doubles as the
 * hover/now-playing affordance surface (an overlaid play wedge, or the
 * dancing bars for the current track), matching how Apple Music / Spotify
 * put those states on the artwork rather than beside the title.
 */
function ArtCell({
  art,
  playing,
  paused,
  onPlay,
}: {
  art: string | null | undefined;
  playing: boolean;
  paused: boolean;
  onPlay(): void;
}) {
  return (
    <span className="art-cell">
      {art ? (
        <img className="art-thumb" src={art} alt="" loading="lazy" draggable={false} />
      ) : (
        <span className="art-thumb art-thumb-empty" aria-hidden>
          {art === null && <NoteIcon />}
        </span>
      )}
      {playing ? (
        <span className="art-overlay art-overlay-playing" aria-hidden>
          <NowPlayingBars paused={paused} />
        </span>
      ) : (
        <button
          type="button"
          className="art-overlay art-overlay-play"
          onClick={(e) => {
            e.stopPropagation();
            onPlay();
          }}
          tabIndex={-1}
          aria-label="Play"
        >
          <PlayIcon />
        </button>
      )}
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
  hiddenColumns,
  artwork,
  onColumnWidths,
  onSort,
  onRowClick,
  onRowContextMenu,
  onHeaderContextMenu,
  onPlay,
}: Props) {
  const columns = visibleColumns(hiddenColumns);
  const dragRef = useRef<{ key: SortKey; startX: number; startW: number } | null>(null);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const tableRef = useRef<HTMLTableElement>(null);
  // The scroll container is the table's parent (main.library). We read
  // its scrollTop/height rather than wrapping our own scroller, so the
  // sticky <thead> and table-layout column sizing keep working.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const rowHeightRef = useRef(0);

  // Virtualization window: only [start, end) of `tracks` becomes real
  // <tr>s; spacer rows stand in for the rest so the scrollbar and row
  // offsets match the full list.
  const [win, setWin] = useState({ scrollTop: 0, viewport: 0 });

  // Measured height of one rendered row (varies with density). Falls
  // back to a sane default before the first row paints. Zero-height
  // rows (e.g. display:none while hidden) never poison the window.
  const measured = tableRef.current?.querySelector<HTMLTableRowElement>("tbody tr[data-row]");
  const rh = measured?.offsetHeight || rowHeightRef.current || 30;

  const window_ = rowWindow({
    scrollTop: win.scrollTop,
    viewport: win.viewport,
    rowHeight: rh,
    total: tracks.length,
    overscan: 8,
  });

  // Latest tracks/rowHeight for the anchor-reveal effect, which fires
  // on anchor change only — reading these through refs keeps a
  // background library refresh from yanking scroll back to the anchor.
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  rowHeightRef.current = rh;

  // Bind scroll + resize listeners to the parent scroller once mounted.
  useLayoutEffect(() => {
    const scroller = tableRef.current?.parentElement ?? null;
    scrollerRef.current = scroller;
    if (!scroller) return;
    const sync = () => setWin({ scrollTop: scroller.scrollTop, viewport: scroller.clientHeight });
    sync();
    scroller.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, []);

  // A cover landing must repaint its row; the cache lives outside React,
  // so a settle callback bumps this tick to pull the resolved data URL.
  const [, bumpArt] = useReducer((n: number) => n + 1, 0);

  // Cover thumbnails load only for rows scrolled into view. One shared
  // observer watches each row's art tile (rootMargin pre-warms a screen
  // ahead); on intersection we ask the cache — which dedups, caps IPC
  // concurrency, and caches negatives — then repaint on settle.
  const observerRef = useRef<IntersectionObserver | null>(null);
  if (observerRef.current == null && typeof IntersectionObserver !== "undefined") {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const path = (entry.target as HTMLElement).dataset.artPath;
          if (path) artwork.request(path, bumpArt);
          observerRef.current?.unobserve(entry.target); // one-shot per row
        }
      },
      { rootMargin: "600px 0px" },
    );
  }
  useEffect(() => () => observerRef.current?.disconnect(), []);

  // Keyboard selection must stay visible (audit P0): when the anchor
  // moves, scroll it into view. With virtualization the anchor row may
  // not be rendered, so we compute the offset from its index instead
  // of relying on a DOM node. null = already visible, so click
  // selection never causes a jump.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (selection.anchor == null || !scroller) return;
    const index = tracksRef.current.findIndex((t) => t.id === selection.anchor);
    if (index < 0) return;
    const headroom = scroller.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    const next = revealOffset({
      index,
      scrollTop: scroller.scrollTop,
      viewport: scroller.clientHeight,
      rowHeight: rowHeightRef.current || 30,
      headroom,
    });
    if (next != null) scroller.scrollTop = next;
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
    <table ref={tableRef} role="grid" aria-multiselectable="true">
      <thead>
        <tr onContextMenu={onHeaderContextMenu}>
          {/* Art column: no label, no sort — a spacer aligning the
              header grid with the thumbnail cells below. */}
          <th className="col-art" aria-hidden />
          {columns.map((c) => (
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
        {window_.padTop > 0 && (
          <tr aria-hidden style={{ height: window_.padTop }}>
            <td className="virt-pad" colSpan={columns.length + 1} />
          </tr>
        )}
        {tracks.slice(window_.start, window_.end).map((t) => {
          const playing = t.id === playingId;
          const selected = selection.ids.has(t.id);
          return (
            <tr
              key={t.id}
              data-row
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
              <td className="col-art">
                <span
                  className="art-observe"
                  data-art-path={t.path}
                  ref={(el) => {
                    if (el) observerRef.current?.observe(el);
                  }}
                >
                  <ArtCell
                    art={artwork.get(t.path)}
                    playing={playing}
                    paused={paused}
                    onPlay={() => onPlay(t)}
                  />
                </span>
              </td>
              {columns.map((c) => {
                switch (c.key) {
                  case "title":
                    return (
                      <td key={c.key}>
                        {displayTitle(t)}
                        {queuePositions.has(t.id) && (
                          <span
                            className="queue-badge"
                            title={`Playing next (#${queuePositions.get(t.id)})`}
                          >
                            {queuePositions.get(t.id)}
                          </span>
                        )}
                      </td>
                    );
                  case "artist":
                    return <td key={c.key}>{t.artist ?? "—"}</td>;
                  case "album":
                    return <td key={c.key}>{t.album ?? "—"}</td>;
                  case "duration_secs":
                    return (
                      <td key={c.key} className="col-duration">
                        {formatTime(t.duration_secs)}
                      </td>
                    );
                  case "bpm":
                    return (
                      <td
                        key={c.key}
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
                    );
                  case "format":
                    return (
                      <td key={c.key} className="col-format">
                        {t.format}
                      </td>
                    );
                  case "first_seen":
                    return (
                      <td key={c.key} className="col-date" title={formatDateTime(t.first_seen)}>
                        {formatDate(t.first_seen)}
                      </td>
                    );
                  case "bpm_analyzed_at":
                    return (
                      <td
                        key={c.key}
                        className="col-date"
                        title={
                          t.bpm_analyzed_at
                            ? formatDateTime(t.bpm_analyzed_at)
                            : "analysis pending"
                        }
                      >
                        {formatDate(t.bpm_analyzed_at)}
                      </td>
                    );
                }
              })}
            </tr>
          );
        })}
        {window_.padBottom > 0 && (
          <tr aria-hidden style={{ height: window_.padBottom }}>
            <td className="virt-pad" colSpan={columns.length + 1} />
          </tr>
        )}
      </tbody>
    </table>
  );
}
