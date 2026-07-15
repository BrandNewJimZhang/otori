// Config invariant: an Overlay title bar has no native drag surface, so
// the toolbar's data-tauri-drag-region is the only way to move the
// window — and that IPC call is ACL-gated. If the capability drops
// core:window:allow-start-dragging, dragging silently dies (core:default
// does NOT include it; verified against the 2.11.5 acl manifest).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));

describe("drag region ACL", () => {
  it("grants start-dragging when a window uses an Overlay title bar", () => {
    const overlayWindows = (conf.app.windows as { titleBarStyle?: string }[]).filter(
      (w) => w.titleBarStyle === "Overlay",
    );
    expect(overlayWindows.length).toBeGreaterThan(0);

    const identifiers = (capability.permissions as (string | { identifier: string })[]).map((p) =>
      typeof p === "string" ? p : p.identifier,
    );
    expect(identifiers).toContain("core:window:allow-start-dragging");
  });
});
