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
