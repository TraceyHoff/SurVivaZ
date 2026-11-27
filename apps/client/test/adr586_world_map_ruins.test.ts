// @vitest-environment jsdom
// ADR-586: the in-game world map accepts a seed source for the abandoned-structure overlay
// and its note carries the legend. (The enumeration itself — that the diamonds name exactly
// the ruins the world stamps — is pinned in packages/gameplay/test/adr586; the canvas is
// null in jsdom, so the overlay's draw path cannot run here.)
import { describe, expect, it } from "vitest";
import { createWorldMap } from "../src/world-map.js";

describe("ADR-586 world map ruins overlay wiring", () => {
  it("constructs with a seed source and the note names the abandoned-structure markers", () => {
    const m = createWorldMap({ world: () => undefined, player: () => undefined, tiles: () => undefined, send: () => false, seed: () => 424242 });
    const note = m.el.querySelector("[data-role=map-note]")!;
    expect(note.textContent).toMatch(/abandoned structures/i);
    m.destroy();
  });

  it("still constructs without a seed source (overlay simply absent)", () => {
    const m = createWorldMap({ world: () => undefined, player: () => undefined, tiles: () => undefined, send: () => false });
    expect(m.el.querySelector("[data-role=map-canvas]")).not.toBeNull();
    m.destroy();
  });
});
