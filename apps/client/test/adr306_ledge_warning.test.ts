// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { GameMenus } from "../src/game-menus.js";
import { classifyLedgeRisk, hiddenDropDirs, pickLedgeHint, LEDGE_COLORS } from "../src/ledge-warning.js";

describe("ADR-306 hidden ledge warnings", () => {
  test("q0 hidden drops face the camera-far sides", () => {
    expect(hiddenDropDirs(0)).toEqual([{ dx: -1, dy: 0 }, { dx: 0, dy: -1 }]);
  });

  test("colors the drop by fall damage against current HP", () => {
    expect(classifyLedgeRisk(3, 100)).toEqual({ damage: 0, risk: "safe" });
    expect(classifyLedgeRisk(4, 100)).toEqual({ damage: 4, risk: "hurt" });
    expect(classifyLedgeRisk(15, 100)).toEqual({ damage: 114, risk: "lethal" });
    expect(classifyLedgeRisk(15, 200).risk).toBe("hurt");
    expect(classifyLedgeRisk(4, 3).risk).toBe("lethal");
    expect(classifyLedgeRisk(15, 100, true)).toEqual({ damage: 0, risk: "safe" });
  });

  test("picks the hidden rim drop the player is walking onto", () => {
    const heightAt = (tx: number, ty: number) => tx === 9 && ty === 10 ? 16 : 20;
    const hint = pickLedgeHint({ x: 10.2, y: 10.5, viewQ: 0, hp: 100, heightAt });
    expect(hint).toMatchObject({ drop: 4, risk: "hurt", dx: -1, dy: 0 });
    expect(LEDGE_COLORS[hint!.risk]).toBe("#F0C040");
    expect(pickLedgeHint({ x: 10.8, y: 10.8, viewQ: 0, hp: 100, heightAt })).toBeUndefined();
    const lethal = pickLedgeHint({
      x: 10.5, y: 10.5, viewQ: 0, hp: 50, facing: Math.atan2(0, -1),
      heightAt: (tx, ty) => tx === 9 && ty === 10 ? 5 : 20,
    });
    expect(lethal).toMatchObject({ drop: 15, risk: "lethal" });
    expect(LEDGE_COLORS.lethal).toBe("#E23B3B");
    expect(LEDGE_COLORS.safe).toBe("#3DCC6A");
  });

  test("settings toggle Hidden ledge warnings defaults on", () => {
    const root = document.createElement("div"); document.body.append(root);
    const m = new GameMenus({ root } as never); m.open("settings");
    const box = root.querySelector<HTMLInputElement>('[data-key="ledge-warnings"]');
    expect(box).toBeTruthy(); expect(box!.checked).toBe(true);
    expect(root.textContent).toContain("Hidden ledge warnings");
  });
});
