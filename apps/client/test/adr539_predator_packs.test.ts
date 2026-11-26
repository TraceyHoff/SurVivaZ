/**
 * ADR-539: the predator-pack warning reuses the HordeStatus channel (kind Pack = 3), so the
 * toast must say "predator pack" — never "zombie horde". Pure helper pins (the live toast
 * wiring is the same hordeCue state machine, already pinned in world_tools.test.ts).
 */
import { describe, expect, it } from "vitest";
import { HordeKind, HordePhase } from "@engine/gameplay";
import { hordeToastText, HORDE_TEXT, PACK_TEXT } from "../src/world-tools.js";

describe("ADR-539 predator pack warning copy", () => {
  it("pack warnings name the pack and its size in predators, never zombies", () => {
    expect(hordeToastText("warning", HordeKind.Pack, 5)).toBe(`${PACK_TEXT.warning} (~5 predators)`);
    expect(hordeToastText("warning", HordeKind.Pack, 5)).not.toContain("zombie");
    expect(hordeToastText("active", HordeKind.Pack, 5)).toBe(PACK_TEXT.active);
    expect(hordeToastText("defeated", HordeKind.Pack, 5)).toBe(PACK_TEXT.defeated);
    expect(PACK_TEXT.warning).not.toContain("zombie");
    expect(PACK_TEXT.active).not.toContain("zombie");
    expect(PACK_TEXT.defeated).not.toContain("zombie");
  });
  it("horde copy is unchanged (kind Solo / Clan still says zombie horde)", () => {
    expect(hordeToastText("warning", HordeKind.Solo, 6)).toBe(`${HORDE_TEXT.warning} (~6 zombies)`);
    expect(hordeToastText("warning", HordeKind.Clan, 12)).toBe(`${HORDE_TEXT.warning} (~12 zombies)`);
    expect(hordeToastText("active", HordeKind.Solo, 6)).toBe(HORDE_TEXT.active);
    expect(hordeToastText("defeated", HordeKind.Clan, 12)).toBe(HORDE_TEXT.defeated);
  });
  it("HordeKind.Pack is 3 and HordePhase is unchanged", () => {
    expect(HordeKind.Pack).toBe(3);
    expect(HordePhase.Warning).toBe(1);
    expect(HordePhase.Active).toBe(2);
  });
});
