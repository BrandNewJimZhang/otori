// Lyrics auto-follow policy (audit R4): a manual scroll pauses the
// auto-centering so the user can read ahead/behind; the follow resumes
// after a grace period of no wheel/touch input (Apple Music behavior).
// Pure so the policy is testable without a DOM.

/** How long a manual scroll suppresses auto-centering. */
export const FOLLOW_GRACE_MS = 4000;

/** Whether the active line should be scrolled into view right now. */
export function shouldFollow(nowMs: number, lastManualScrollMs: number | null): boolean {
  if (lastManualScrollMs == null) return true;
  return nowMs - lastManualScrollMs >= FOLLOW_GRACE_MS;
}
