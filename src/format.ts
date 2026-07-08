// Time formatting shared by the player bar and (later) the duration column.

/** Seconds → "m:ss" / "h:mm:ss"; non-finite input → placeholder. */
export function formatTime(secs: number | null): string {
  if (secs == null || !Number.isFinite(secs)) return "–:––";
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The index stamps SQLite `datetime('now')`: UTC "YYYY-MM-DD HH:MM:SS". */
function parseUtc(stamp: string | null): Date | null {
  if (!stamp) return null;
  const d = new Date(stamp.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** UTC index timestamp → local "YYYY-MM-DD" (Added/Analyzed cells);
    null (pending) or garbage → placeholder. */
export function formatDate(stamp: string | null): string {
  const d = parseUtc(stamp);
  if (!d) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** UTC index timestamp → local "YYYY-MM-DD HH:MM" (cell tooltips). */
export function formatDateTime(stamp: string | null): string {
  const d = parseUtc(stamp);
  if (!d) return "—";
  return `${formatDate(stamp)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
