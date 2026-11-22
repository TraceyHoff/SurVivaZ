// ADR-511: Art's 80 px floor (5 terrain levels) flipped together with the 3bab4025 art, plus the two roof defects the
// ADR-509 renders showed: wall post tops / log corners drawn over the eave (WebGL2 depth), and the cottage chimney
// splitting the roof region (a dark flat patch around it).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RFX, RFX_ANY_GROUP, rfxPickLevel, type RfxTile } from "@engine/assets";
import { RFX_SEAT_BIAS } from "@engine/render";
import { FLOOR_HEIGHT_LEVELS, DEFAULT_ISO } from "@engine/world";
import { rfxStandIn } from "../src/roof-tiler.js";

const ROOT = resolve(__dirname, "../../..");
const json = <T>(p: string): T => JSON.parse(readFileSync(resolve(ROOT, p), "utf8")) as T;

describe("ADR-511 the floor is 80 px everywhere at once", () => {
  it("tiers levelHeight = FLOOR_HEIGHT_LEVELS = 5; zStep x 5 = RFX.levelPx = 80", () => {
    expect(json<{ building: { levelHeight: number } }>("packages/gameplay/data/tiers.json").building.levelHeight).toBe(5);
    expect(FLOOR_HEIGHT_LEVELS).toBe(5); expect(DEFAULT_ISO.zStep * FLOOR_HEIGHT_LEVELS).toBe(80); expect(RFX.levelPx).toBe(80);
  });
  it("stairs: the stand-height ease keeps up with a one-tile 5-level ramp and a deck step still eases (stepCatchUp)", () => {
    const mv = json<{ stepRate: number; stepCatchUp: number; walkSpeed: number; deckStandHeight: number }>("packages/gameplay/data/movement.json");
    // crossing the stair tile at walk speed: target climbs at LH x walkSpeed z/s; with the catch-up the lag settles at
    // (LH x walkSpeed) / stepCatchUp, so z at the top edge is past the half-floor mark (level rounds to 1 on the landing)
    const lag = (FLOOR_HEIGHT_LEVELS * mv.walkSpeed) / mv.stepCatchUp; expect(FLOOR_HEIGHT_LEVELS - lag).toBeGreaterThan(FLOOR_HEIGHT_LEVELS / 2);
    // a 0.75 deck step is not faster than before (stepRate bound): >= 2 eased ticks at 20 Hz
    expect(mv.deckStandHeight * mv.stepCatchUp).toBeLessThanOrEqual(mv.stepRate + 1e-9);
  });
});

describe("ADR-511 roof fixes", () => {
  it("rfx parts out-rank the high end of a roof-covered wall (its end post sits 16 px higher on screen than the pivot)", () => {
    // front edge wall top key = edge + 0.45 + (top + 16 at its high end) px / 48; vertex post +0.53; roof = one floor + seat
    const top = 92, seat = Math.min(...Object.values(RFX.forms).map((f) => f.seatPx ?? 0));
    expect(RFX_SEAT_BIAS).toBeGreaterThan(0.45 + (top + 16) / 48 + 0.53 - RFX.levelPx / 48 - 0.05 - seat / 48);
    expect(RFX_SEAT_BIAS).toBeLessThanOrEqual(1.6); // small headroom only: Canvas2D draws roofs level-major (always over level 0); GL stays close to that, not past it
  });
  const cottage = (chimney: boolean): RfxTile[] => { const t: RfxTile[] = []; for (let y = 0; y < 6; y++) for (let x = 0; x < 7; x++) t.push({ x, y, key: chimney && x === 5 && y === 2 ? "roof_chimney" : "roof_cottage", rot: 0, tier: 2 }); return t; };
  it("a chimney joins the roof it stands in: the cottage picks are the same with and without it (no hole, no inner eave)", () => {
    expect(RFX.groups.roof_chimney).toBe(RFX_ANY_GROUP);
    const a = rfxPickLevel(cottage(false), 1), b = rfxPickLevel(cottage(true), 1);
    for (const [k, p] of a) { const q = b.get(k)!; expect(q.stem, k).toBe(p.stem); expect(q.zoffPx, k).toBe(p.zoffPx); expect(q.region, k).toBe(0); }
    expect(b.get("5,2")!.overlays.some((o) => o.key === "rfx_chimney")).toBe(true);
    // gambrel and shed too; a lone chimney is still its own (legacy -> hip) roof
    for (const key of ["roof_gambrel", "roof_shed", "roof_slope"]) { const t = cottage(true).map((x) => (x.key === "roof_cottage" ? { ...x, key } : x)); const p = rfxPickLevel(t, 1); expect(new Set([...p.values()].map((x) => x.region)).size, key).toBe(1); }
    expect(rfxPickLevel([{ x: 0, y: 0, key: "roof_chimney", rot: 0, tier: 1 }], 1).get("0,0")!.form).toBe("hip");
    expect(rfxStandIn("roof_chimney", 0, 1, () => "x@y")).toBeUndefined(); // the chimney keeps its legacy picture before it joins a roof
  });
});
