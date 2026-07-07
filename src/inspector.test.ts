// The inspector's pure logic contract: merging N selected tracks into
// display values, diffing edits into FieldChange[], and building the
// CLI-equivalent command (L5: the GUI teaches automation by example).

import { describe, expect, it } from "vitest";
import {
  buildCliCommand,
  diffEdits,
  mergeField,
  MULTIPLE,
  type FieldEdits,
} from "./inspector";

describe("mergeField", () => {
  it("returns the value when all tracks agree", () => {
    expect(mergeField(["Iris", "Iris"])).toEqual({ kind: "agree", value: "Iris" });
  });

  it("treats a single track as agreement", () => {
    expect(mergeField(["Iris"])).toEqual({ kind: "agree", value: "Iris" });
  });

  it("returns multiple when values disagree", () => {
    expect(mergeField(["Iris", "GHOST"])).toEqual({ kind: "multiple" });
  });

  it("null vs value is a disagreement, not empty", () => {
    expect(mergeField([null, "Iris"])).toEqual({ kind: "multiple" });
  });

  it("all-null is empty", () => {
    expect(mergeField([null, null])).toEqual({ kind: "empty" });
  });
});

describe("diffEdits", () => {
  const merged = {
    title: { kind: "agree", value: "Iris" },
    artist: { kind: "multiple" },
    album: { kind: "empty" },
  } as const;

  it("emits only fields the user actually changed", () => {
    const edits: FieldEdits = { title: "IRIS", artist: null, album: null };
    expect(diffEdits(merged, edits)).toEqual([{ field: "title", value: "IRIS" }]);
  });

  it("an untouched multiple placeholder writes nothing", () => {
    const edits: FieldEdits = { title: null, artist: null, album: null };
    expect(diffEdits(merged, edits)).toEqual([]);
  });

  it("typing into a multiple field targets all tracks", () => {
    const edits: FieldEdits = { title: null, artist: "Camellia", album: null };
    expect(diffEdits(merged, edits)).toEqual([{ field: "artist", value: "Camellia" }]);
  });

  it("re-typing the agreed value is a no-op", () => {
    const edits: FieldEdits = { title: "Iris", artist: null, album: null };
    expect(diffEdits(merged, edits)).toEqual([]);
  });

  it("filling an empty field is a change", () => {
    const edits: FieldEdits = { title: null, artist: null, album: "U.U.F.O." };
    expect(diffEdits(merged, edits)).toEqual([{ field: "album", value: "U.U.F.O." }]);
  });

  it("whitespace-only input never writes", () => {
    const edits: FieldEdits = { title: "  ", artist: null, album: null };
    expect(diffEdits(merged, edits)).toEqual([]);
  });
});

describe("buildCliCommand", () => {
  it("builds a single-file set command", () => {
    expect(
      buildCliCommand(["/lib/a.mp3"], [{ field: "title", value: "Iris" }]),
    ).toBe('otori set "/lib/a.mp3" --title "Iris" --apply');
  });

  it("quotes embedded double quotes and dollars", () => {
    expect(
      buildCliCommand(["/lib/a.mp3"], [{ field: "title", value: 'Say "hoy" $now' }]),
    ).toBe('otori set "/lib/a.mp3" --title "Say \\"hoy\\" \\$now" --apply');
  });

  it("renders a batch as one command per file", () => {
    expect(
      buildCliCommand(
        ["/lib/a.mp3", "/lib/b flac.flac"],
        [{ field: "album", value: "X" }],
      ),
    ).toBe(
      'otori set "/lib/a.mp3" --album "X" --apply\n' +
        'otori set "/lib/b flac.flac" --album "X" --apply',
    );
  });
});

describe("MULTIPLE sentinel", () => {
  it("is not a plausible tag value", () => {
    // Rendered as a placeholder, never written; keep it visually obvious.
    expect(MULTIPLE).toMatch(/[⟨⟩]/);
  });
});
