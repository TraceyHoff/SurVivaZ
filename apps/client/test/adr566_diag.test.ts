// @vitest-environment jsdom
import { describe, expect, test, vi, afterEach } from "vitest";
import { startDiag } from "../src/diag.js";

/**
 * ADR-566 diag wiring: with ?diag=1 the structure dump is reachable as
 * window.__survivazStructureDump() (the ADR-370 __survivazLoadCost pattern) and via the
 * [Dump structure] button, which opens a copyable text block. With ?diag absent,
 * startDiag installs nothing — no global, no button, no overlay.
 */

const DUMP = "SURVIVAZ_STRUCTURE_DUMP 1\ncenter 6 6\nradius 12\nview 0\nbounds -6 -6 25 25\nheights\n3\npieces 0\nend";

afterEach(() => {
  document.querySelector("#diag")?.remove();
  document.querySelector("#diag-structure-dump")?.remove();
  document.querySelector("#diag-structure-text")?.remove();
  document.querySelector("#game-root")?.remove();
  delete (globalThis as { __survivazStructureDump?: unknown }).__survivazStructureDump;
  vi.clearAllTimers();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const sources = (structureDump?: () => string | undefined) => ({
  renderer: () => undefined, entities: () => 0, tick: () => 0, player: () => undefined,
  snapshot: () => undefined, ...(structureDump ? { structureDump } : {}),
});

describe("ADR-566 ?diag=1 structure dump wiring", () => {
  test("diag off: startDiag returns undefined and installs no dump surface", () => {
    window.history.replaceState(null, "", "/");
    expect(startDiag(sources(() => DUMP))).toBeUndefined();
    expect((globalThis as { __survivazStructureDump?: unknown }).__survivazStructureDump).toBeUndefined();
    expect(document.querySelector("#diag-structure-dump")).toBeNull();
    expect(document.querySelector("#diag")).toBeNull();
  });

  test("diag on: __survivazStructureDump() returns + logs the dump, and the button opens a copyable text block", () => {
    window.history.replaceState(null, "", "/?diag=1");
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    startDiag(sources(() => DUMP));
    const fn = (globalThis as { __survivazStructureDump?: () => string | undefined }).__survivazStructureDump;
    expect(typeof fn).toBe("function");
    expect(fn!()).toBe(DUMP);
    expect(log).toHaveBeenCalledWith(DUMP);

    const btn = document.querySelector<HTMLButtonElement>("#diag-structure-dump");
    expect(btn).not.toBeNull();
    btn!.click();
    const ta = document.querySelector<HTMLTextAreaElement>("#diag-structure-text");
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe(DUMP);
    log.mockRestore();
  });
});
