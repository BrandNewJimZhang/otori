// formatTime: the player bar's time display contract.

import { describe, expect, it } from "vitest";
import { formatTime } from "./format";

describe("formatTime", () => {
  it("formats seconds as m:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(245.5)).toBe("4:05");
  });

  it("rolls hours into h:mm:ss", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(3725)).toBe("1:02:05");
  });

  it("renders unknown durations as a placeholder", () => {
    expect(formatTime(NaN)).toBe("–:––");
    expect(formatTime(null)).toBe("–:––");
    expect(formatTime(Infinity)).toBe("–:––");
  });
});
