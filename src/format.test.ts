// formatTime: the player bar's time display contract.

import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatTime } from "./format";

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

// The index stamps SQLite `datetime('now')` — UTC "YYYY-MM-DD HH:MM:SS".
// These columns render in local time; CI pins TZ via the date output
// shape (YYYY-MM-DD), not a fixed zone.
describe("formatDate", () => {
  it("renders a SQLite UTC timestamp as a local YYYY-MM-DD date", () => {
    expect(formatDate("2026-07-01 10:30:00")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("shifts across the local day boundary, not the UTC one", () => {
    // 23:30 UTC lands on the next local day anywhere east of UTC+1.
    const local = new Date(Date.UTC(2026, 6, 1, 23, 30));
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(
      local.getDate(),
    ).padStart(2, "0")}`;
    expect(formatDate("2026-07-01 23:30:00")).toBe(expected);
  });

  it("renders null (pending) and garbage as a placeholder", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });
});

describe("formatDateTime", () => {
  it("renders the full local timestamp for tooltips", () => {
    const s = formatDateTime("2026-07-01 10:30:00");
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("renders null and garbage as a placeholder", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("")).toBe("—");
  });
});
