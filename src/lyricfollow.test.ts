// Lyrics auto-follow vs manual browsing (audit R4): scrolling the pane
// to read ahead must not be yanked back by the next line change; the
// follow resumes after a grace period, Apple Music-style.

import { describe, expect, it } from "vitest";
import { FOLLOW_GRACE_MS, shouldFollow } from "./lyricfollow";

describe("shouldFollow", () => {
  it("follows when the user never scrolled", () => {
    expect(shouldFollow(10_000, null)).toBe(true);
  });

  it("pauses inside the grace window after a manual scroll", () => {
    expect(shouldFollow(10_000, 10_000)).toBe(false);
    expect(shouldFollow(10_000 + FOLLOW_GRACE_MS - 1, 10_000)).toBe(false);
  });

  it("resumes once the grace window has passed", () => {
    expect(shouldFollow(10_000 + FOLLOW_GRACE_MS, 10_000)).toBe(true);
  });
});
