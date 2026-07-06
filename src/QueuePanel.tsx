// Up-next panel (audit r5 P0): the play-next queue and the play order
// were invisible outside the table's number badges. A player-bar
// toggle slides this panel over the table's right edge: explicit
// queue first (reorder/remove/clear), then a short preview of where
// the play order goes next. Pure presentation — queue state and the
// order preview both live in App.

import type { TrackRow } from "./types";
import { displayTitle } from "./library";

interface Props {
  /** Explicit play-next picks, in play order. */
  queueTracks: TrackRow[];
  /** Where the play order goes after the queue drains (short preview). */
  upcoming: TrackRow[];
  onPlay(track: TrackRow): void;
  onMove(id: number, offset: 1 | -1): void;
  onRemove(id: number): void;
  onClear(): void;
  onClose(): void;
}

export function QueuePanel({
  queueTracks,
  upcoming,
  onPlay,
  onMove,
  onRemove,
  onClear,
  onClose,
}: Props) {
  return (
    <aside className="queue-panel" aria-label="Play queue">
      <header className="queue-panel-head">
        <h2>Up next</h2>
        {queueTracks.length > 0 && (
          <button className="queue-clear" onClick={onClear}>
            Clear
          </button>
        )}
        <button className="queue-close" onClick={onClose} aria-label="Close queue">
          ×
        </button>
      </header>

      {queueTracks.length === 0 && upcoming.length === 0 && (
        <p className="queue-empty">Nothing queued — right-click a track and “Play next”.</p>
      )}

      {queueTracks.length > 0 && (
        <ol className="queue-list">
          {queueTracks.map((t, i) => (
            <li key={t.id}>
              <button className="queue-row" onDoubleClick={() => onPlay(t)}>
                <span className="queue-pos">{i + 1}</span>
                <span className="queue-row-text">
                  <span className="queue-row-title">{displayTitle(t)}</span>
                  <span className="queue-row-artist">{t.artist ?? "—"}</span>
                </span>
              </button>
              <span className="queue-row-actions">
                <button onClick={() => onMove(t.id, -1)} disabled={i === 0} aria-label="Move up">
                  ↑
                </button>
                <button
                  onClick={() => onMove(t.id, 1)}
                  disabled={i === queueTracks.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button onClick={() => onRemove(t.id)} aria-label="Remove from queue">
                  ×
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {upcoming.length > 0 && (
        <>
          <h3 className="queue-section">Continuing with</h3>
          <ol className="queue-list upcoming">
            {upcoming.map((t) => (
              <li key={t.id}>
                <button className="queue-row" onDoubleClick={() => onPlay(t)}>
                  <span className="queue-pos">·</span>
                  <span className="queue-row-text">
                    <span className="queue-row-title">{displayTitle(t)}</span>
                    <span className="queue-row-artist">{t.artist ?? "—"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
