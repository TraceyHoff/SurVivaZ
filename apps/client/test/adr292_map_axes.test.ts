// @vitest-environment jsdom
import { expect, it } from "vitest";
import { compassOf } from "@engine/gameplay";
import { worldToCanvas, canvasToWorld, createWorldMap } from "../src/world-map.js";

it.each([[-1, -1, 0], [1, -1, 90], [1, 1, 180], [-1, 1, 270]])("ADR-292 map and compass agree %s,%s", (x, y, heading) => {
  const c = { x: 123, y: -42 }, a = worldToCanvas(c.x + x, c.y + y, 480, 360, c, 16);
  expect(compassOf(Math.atan2(y, x)).heading).toBeCloseTo(heading);
  const angle = heading * Math.PI / 180;
  expect(a.px - 240).toBeCloseTo(Math.sin(angle) * Math.SQRT2 * 16);
  expect(a.py - 180).toBeCloseTo(-Math.cos(angle) * Math.SQRT2 * 16);
  const picked = canvasToWorld(a.px, a.py, 480, 360, c, 16);
  expect(picked.x).toBeCloseTo(c.x + x); expect(picked.y).toBeCloseTo(c.y + y);
});
it("ADR-292 preserves the canvas aspect ratio in portrait rather than stretching its compass", () => {
  const m = createWorldMap({ world: () => undefined, player: () => undefined, tiles: () => undefined, send: () => false });
  const canvas = m.el.querySelector("canvas")!;
  expect(canvas.style.height).toBe("auto"); expect(canvas.style.aspectRatio).toBe("4/3");
  expect(m.el.textContent).toContain("North is up"); m.destroy();
});
