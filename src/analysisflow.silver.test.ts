// SILVER layer — eval-expansion round 5 (protocol: docs/design/
// eval-expansion-round1.md). Analysis-flow domain: model-select
// orchestration (analysismodel) and sweep pacing/ETA math
// (analysissweep). Cases generated adversarially from the contracts by
// a blind generator (no implementation, no existing tests in context),
// then adjudicated against the current implementations. Silver
// semantics: append-only for the model; a human may revoke any case
// (gold wins).
//
// Dedup record (exactly-covered assertions skipped, not re-asserted):
// - AF-1/2/3 (three no-op guards) are analysismodel.test "no-ops on
//   already-active, unknown, or in-flight" — the guard identities are
//   dup; the RETURN VALUE legs (false, and true on the attempt paths)
//   and the zero-toast/zero-onError assertions are new, kept below.
// - AF-4 (download precedes switch) is analysismodel.test "downloads
//   first when the weights are absent" — ordering dup; the
//   onSwitched-after-await leg is new.
// - AF-5 (download failure) is analysismodel.test "a download failure
//   is a toast and no switch" — dup except the return-true leg.
// - AF-6 (switch failure → onError) is analysismodel.test — dup
//   except the return-true and zero-download legs.
// - AF-7 (available skips download) is analysismodel.test "switches
//   directly" — dup; the zero-toast leg is new.
// - AF-9 (wrap-around) and the empty-registry leg of AF-10 are
//   analysismodel.test — dup, skipped.
// - AF-12 (duty-cycle inequality) is analysissweep.test "keeps duty
//   cycle at or under 10%" — the single-point check is dup; the
//   large-workMs sweep below is new.
// - AF-13 null gates and AF-14 window truncation are analysissweep
//   .test — dup except the exactly-4-samples boundary leg.
//
// Generator ambiguities resolved by the adjudicator without gold:
// - AF-11 (tight 9·w vs conservative 10·w stretch): the existing test
//   locks paceDelayMs(1000) = 9000, so the stretch is the tight bound
//   (w·(1-D)/D = 9w) — crossover at w = 1000/3. Locked green at the
//   derived points.
// - AF-8 (download-start toast): the contract names the failure toast
//   only, but "Downloading …" before the fetch is the implementation's
//   actual behavior and matches the product anchor (a click must have
//   visible effect). Locked green.
// - AF-9 availability filter: nextModelId does NOT skip unavailable
//   models — cycling to one triggers download-then-switch, which is
//   the download-on-demand design. Locked green.

import { describe, expect, it, vi } from "vitest";
import {
  nextModelId,
  performModelSelect,
  type ModelSelectEffects,
} from "./analysismodel";
import { computeEtaMs, paceDelayMs } from "./analysissweep";

const MODELS = [
  { id: "small", label: "Small", available: true },
  { id: "standard", label: "Standard", available: false },
];

function fx(overrides: Partial<ModelSelectEffects> = {}): ModelSelectEffects {
  return {
    switchModel: vi.fn().mockResolvedValue(undefined),
    downloadModel: vi.fn().mockResolvedValue(undefined),
    onSwitched: vi.fn(),
    onError: vi.fn(),
    toast: vi.fn(),
    ...overrides,
  };
}

describe("silver: performModelSelect return-value contract (AF-1/2/3/5/6)", () => {
  // Derivation: false = pure no-op (nothing ran), true = an attempt
  // ran even if it failed. The caller resets its `switching` flag off
  // this value — inverting either direction wedges the UI.
  it("no-op paths return false with zero effects, including toast", async () => {
    const f = fx();
    expect(await performModelSelect(f, "small", MODELS, "small", false)).toBe(false);
    expect(await performModelSelect(f, "ghost", MODELS, "small", false)).toBe(false);
    expect(await performModelSelect(f, "standard", MODELS, "small", true)).toBe(false);
    expect(f.toast).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("a failed download still returns true (the attempt ran and surfaced)", async () => {
    const f = fx({ downloadModel: vi.fn().mockRejectedValue(new Error("checksum")) });
    expect(await performModelSelect(f, "standard", MODELS, "small", false)).toBe(true);
  });

  it("a failed switch still returns true, with zero downloads", async () => {
    const f = fx({ switchModel: vi.fn().mockRejectedValue(new Error("ipc boom")) });
    expect(await performModelSelect(f, "small", MODELS, "standard", false)).toBe(true);
    expect(f.downloadModel).not.toHaveBeenCalled();
  });
});

describe("silver: effect ordering under async settlement (AF-4, AF-8)", () => {
  // Derivation: onSwitched persists the id and restarts the sweep —
  // firing it before switchModel settles would let the sweep run
  // against the OLD shell model. Verified with a deferred resolve.
  it("onSwitched fires only after switchModel settles", async () => {
    let resolveSwitch!: () => void;
    const order: string[] = [];
    const f = fx({
      switchModel: vi.fn(() => {
        order.push("switch-called");
        return new Promise<void>((r) => {
          resolveSwitch = () => {
            order.push("switch-settled");
            r();
          };
        });
      }),
      onSwitched: vi.fn(() => order.push("onSwitched")),
    });
    const done = performModelSelect(f, "small", MODELS, "standard", false);
    expect(order).toEqual(["switch-called"]); // not yet settled
    resolveSwitch();
    await done;
    expect(order).toEqual(["switch-called", "switch-settled", "onSwitched"]);
  });

  // Derivation: a model download can take tens of seconds — the click
  // must have visible effect BEFORE the fetch, not after (product
  // anchor: the user asked; silence is failure's twin).
  it("the downloading toast fires before downloadModel is called", async () => {
    const order: string[] = [];
    const f = fx({
      toast: vi.fn(() => order.push("toast")),
      downloadModel: vi.fn(() => {
        order.push("download");
        return Promise.resolve();
      }),
    });
    await performModelSelect(f, "standard", MODELS, "small", false);
    expect(order.slice(0, 2)).toEqual(["toast", "download"]);
    expect((f.toast as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("Standard");
  });

  // Derivation: a direct switch (weights present) is ambient — no
  // download announcement, no success fanfare.
  it("a direct switch emits no toast", async () => {
    const f = fx();
    await performModelSelect(f, "small", MODELS, "standard", false);
    expect(f.toast).not.toHaveBeenCalled();
  });
});

describe("silver: nextModelId degenerate registries (AF-10)", () => {
  const one = [{ id: "a", label: "A", available: true }];
  const two = [
    { id: "a", label: "A", available: true },
    { id: "b", label: "B", available: false },
  ];

  // GOLD RULING 2026-07-15: keep as-is (performModelSelect's
  // already-active guard eats the no-op select, so no user-visible
  // harm; the locked rendering doubles as the tripwire). Was flagged:
  // a single-model registry returns the active id itself — the cycle
  // button offers a guaranteed no-op, while the contract says null =
  // "nothing to cycle to" and a one-model registry has nothing to
  // cycle to.
  it("a single-model registry cycles to itself (contract says null — flagged)", () => {
    expect(nextModelId(one, "a")).toBe("a");
  });

  // Derivation: an activeId absent from the registry (registry
  // evolved, pref stamped an old id) must not break the button.
  // findIndex -1 + 1 = 0 → the registry head: the button recovers by
  // cycling to a known model. Locked green.
  it("an unknown activeId wraps to the registry head", () => {
    expect(nextModelId(two, "zombie")).toBe("a");
  });

  // Derivation: cycling lands on unavailable models too — that IS the
  // download-on-demand entry point (AF-9 ambiguity resolution).
  it("cycling does not skip unavailable models", () => {
    expect(nextModelId(two, "a")).toBe("b");
  });
});

describe("silver: paceDelayMs floor/stretch crossover (AF-11)", () => {
  // Derivation: sleep = max(3000, w·(1-0.1)/0.1) = max(3000, 9w);
  // crossover at 9w = 3000 → w = 333.33. One point either side pins
  // the max() structure; the tight bound is locked by the existing
  // 1000→9000 case.
  it("straddles the crossover: floor at 333, stretch at 334", () => {
    expect(paceDelayMs(333)).toBe(3000); // 9·333 = 2997 < 3000
    expect(paceDelayMs(334)).toBe(3006); // 9·334 = 3006 > 3000
  });

  it("holds the duty-cycle inequality across the expensive range", () => {
    for (const w of [5_000, 60_000, 600_000]) {
      const d = paceDelayMs(w);
      expect(w / (w + d)).toBeLessThanOrEqual(0.1);
      expect(d).toBeGreaterThanOrEqual(9 * w);
    }
  });
});

describe("silver: computeEtaMs seeding boundary (AF-13)", () => {
  // Derivation: "below ETA_MIN_SAMPLES the ETA is too noisy" — the
  // boundary direction is ≥4 shows. The existing test locks 3 → null;
  // this pins exactly-4 → value, closing the off-by-one window.
  it("exactly four samples seed the ETA", () => {
    expect(computeEtaMs([3000, 3000, 3000, 3000], 5)).toBe(15000);
  });
});
