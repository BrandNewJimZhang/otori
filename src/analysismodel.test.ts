// Model-select orchestration: guard paths, the download ladder, and
// failure surfacing — every branch the status-bar button and Settings
// picker share.

import { describe, expect, it, vi } from "vitest";
import { nextModelId, performModelSelect, type ModelSelectEffects } from "./analysismodel";

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

describe("performModelSelect", () => {
  it("switches directly when the weights are present", async () => {
    const f = fx();
    const ran = await performModelSelect(f, "small", MODELS, "standard", false);
    expect(ran).toBe(true);
    expect(f.downloadModel).not.toHaveBeenCalled();
    expect(f.switchModel).toHaveBeenCalledWith("small");
    expect(f.onSwitched).toHaveBeenCalledWith("small");
  });

  it("downloads first when the weights are absent, then switches", async () => {
    const f = fx();
    await performModelSelect(f, "standard", MODELS, "small", false);
    expect(f.toast).toHaveBeenCalledWith("Downloading Standard model…");
    expect(f.downloadModel).toHaveBeenCalledWith("standard");
    expect(f.switchModel).toHaveBeenCalledWith("standard");
  });

  it("a download failure is a toast and no switch", async () => {
    const f = fx({ downloadModel: vi.fn().mockRejectedValue(new Error("checksum")) });
    const ran = await performModelSelect(f, "standard", MODELS, "small", false);
    expect(ran).toBe(true); // the attempt ran; caller resets its switching latch
    expect(f.toast).toHaveBeenCalledWith("Standard download failed: Error: checksum");
    expect(f.switchModel).not.toHaveBeenCalled();
    expect(f.onSwitched).not.toHaveBeenCalled();
  });

  it("a switch failure surfaces through onError", async () => {
    const f = fx({ switchModel: vi.fn().mockRejectedValue(new Error("reopen failed")) });
    await performModelSelect(f, "small", MODELS, "standard", false);
    expect(f.onError).toHaveBeenCalledWith("Error: reopen failed");
    expect(f.onSwitched).not.toHaveBeenCalled();
  });

  it("no-ops on already-active, unknown, or in-flight", async () => {
    const f = fx();
    expect(await performModelSelect(f, "small", MODELS, "small", false)).toBe(false);
    expect(await performModelSelect(f, "nope", MODELS, "small", false)).toBe(false);
    expect(await performModelSelect(f, "standard", MODELS, "small", true)).toBe(false);
    expect(f.switchModel).not.toHaveBeenCalled();
    expect(f.downloadModel).not.toHaveBeenCalled();
  });
});

describe("nextModelId", () => {
  it("cycles through the registry, wrapping", () => {
    expect(nextModelId(MODELS, "small")).toBe("standard");
    expect(nextModelId(MODELS, "standard")).toBe("small");
  });

  it("is null on an empty registry", () => {
    expect(nextModelId([], "small")).toBeNull();
  });
});
