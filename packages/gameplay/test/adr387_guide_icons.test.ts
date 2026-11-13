/**
 * ADR-387: guide listings show their own icons.
 * - Every disease row shows the disease's status icon (diseaseIcon) — the broken-leg listing shows
 *   the broken-leg icon, "broken_leg", the same UI-atlas art the HUD disease chips show.
 * - Treats rows show their pet, horse rows their mount, format:"item" rows their item, and the
 *   explicit FACT_ICONS rows their piece / item / ic_ file icon.
 * - Every guide-kind icon resolves in its defs table (item / piece / vehicle / mount / pet); every
 *   condition icon is a diseaseIcon() value; every file icon is one of the game's embedded ic_ icons.
 * - Rows that describe a number, not a thing, have no icon — the counts are pinned so a future
 *   guide.json change forces a conscious update, not a silent drift.
 * Relative imports only: a package must never self-import by package name in its own tests (ADR-347).
 */
import { describe, expect, it } from "vitest";
import {
  getGuideSections, guideFactIcon, resolvedGuideSection,
  type GuideFactFormat, type GuideIconRef, type GuideRowIcon,
} from "../src/guide.js";
import { defaultDefs } from "../src/data.js";
import { diseaseIcon } from "../src/diseases.js";
import { mountSpeciesOfKey } from "../src/mount_defs.js";
import { vehicleDefId } from "../src/vehicles.js";
import petsRaw from "../data/pets.json";

const guide = (key: GuideIconRef): GuideRowIcon => ({ kind: "guide", key });
const file = (fileName: string): GuideRowIcon => ({ kind: "file", file: fileName });

/** The explicit FACT_ICONS map, pinned row by row (prefix/format rules are pinned separately below). */
const EXPECTED_MAP: Readonly<Record<string, GuideRowIcon>> = {
  "temperature.furCoatInsulation": guide("item:fur_coat"),
  "temperature.furHatInsulation": guide("item:fur_hat"),
  "food.saltConsumeSeconds": guide("item:salt"),
  "animals.ropeAttachRangeTiles": guide("item:rope"),
  "animals.ropeBreakDistanceTiles": guide("item:rope"),
  "cooking.campfireRecipeCount": guide("piece:campfire"),
  "building.claimCost": guide("piece:claim_totem"),
  "building.claimRadiusTiles": guide("piece:claim_totem"),
  "animals.troughRangeTiles": guide("piece:feeding_trough"),
  "storage.oreAccepts": guide("piece:ore_store"),
  "storage.cropAcceptsCount": guide("piece:crop_store"),
  "storage.saltBarrelMul": guide("piece:salt_barrel"),
  "storage.curingBoxMul": guide("piece:curing_box"),
  "storage.coldStoreMul": guide("piece:cold_store"),
  "trade.stallBlanketListings": guide("piece:stall_blanket"),
  "trade.stallCartListings": guide("piece:stall_cart"),
  "trade.stallBoothListings": guide("piece:stall_booth"),
  "trade.stallPavilionListings": guide("piece:clan_pavilion"),
  "trade.stallCounterListings": guide("piece:market_counter"),
  "vehicles.chariotGallopCap": guide("vehicle:chariot"),
  "vehicles.wagonLargeGallopCap": guide("vehicle:wagon_large"),
  "vehicles.carriageSeats": guide("vehicle:carriage"),
  "vehicles.wagonLargeStorageSlots": guide("vehicle:wagon_large"),
  "inventory.packSlots": file("ic_backpack.png"),
  "inventory.hotbarSlots": file("ic_backpack.png"),
  "inventory.totalSlots": file("ic_backpack.png"),
  "farming.plantableCount": file("ic_plant.png"),
  "temperature.bodyFreezingC": file("ic_snowflake.png"),
  "temperature.bodyOverheatingC": file("ic_temp.png"),
  "temperature.freezingC": file("ic_snowflake.png"),
  "temperature.fireHeatMaxC": file("ic_fire.png"),
  "temperature.fireHeatTauSeconds": file("ic_fire.png"),
  "food.frozenBelowC": file("ic_snowflake.png"),
  "combat.fireDps": file("ic_fire.png"),
  "combat.fireSpreadChance": file("ic_fire.png"),
  "combat.fireSpreadRadiusTiles": file("ic_fire.png"),
  "seasons.summer.tempRange": file("ic_sun.png"),
  "seasons.summer.heatWaveRange": file("ic_sun.png"),
  "seasons.fall.tempRange": file("ic_leaf.png"),
  "seasons.winter.tempRange": file("ic_snowflake.png"),
};

/** The ic_ files the derivation may name (existence in ICON_DATA is pinned by the ADR-387 client test). */
const KNOWN_FILES = new Set([
  "ic_backpack.png", "ic_snowflake.png", "ic_temp.png", "ic_fire.png",
  "ic_plant.png", "ic_sun.png", "ic_leaf.png",
]);

/** Every fact row in the shipped guide, with its resolved icon (raw and resolved stay in order). */
function allFactRows(): { section: string; fact: string; format: GuideFactFormat; label: string; icon: GuideRowIcon | undefined }[] {
  const out: { section: string; fact: string; format: GuideFactFormat; label: string; icon: GuideRowIcon | undefined }[] = [];
  for (const s of getGuideSections()) {
    const r = resolvedGuideSection(s.id)!;
    const rawFacts = s.items.filter((i): i is { fact: string; format: GuideFactFormat; label: string } => "fact" in i);
    const resolvedFacts = r.items.filter((i): i is { kind: "fact"; label: string; value: string; icon: GuideRowIcon | undefined } => i.kind === "fact");
    expect(rawFacts.length).toBe(resolvedFacts.length);
    rawFacts.forEach((raw, i) => out.push({ section: s.id, fact: raw.fact, format: raw.format, label: resolvedFacts[i]!.label, icon: resolvedFacts[i]!.icon }));
  }
  return out;
}

function resolves(icon: GuideRowIcon): boolean {
  if (icon.kind !== "guide") return true;
  const [kind, key] = icon.key.split(":", 2);
  try {
    switch (kind) {
      case "item": defaultDefs().itemId(key!); return true;
      case "piece": defaultDefs().pieceId(key!); return true;
      case "vehicle": return vehicleDefId(key!) > 0;
      case "mount": return mountSpeciesOfKey(key!) > 0;
      case "pet": return (petsRaw as { species: { key: string }[] }).species.some((p) => p.key === key);
    }
  } catch { return false; }
  return false;
}

describe("ADR-387 guide fact-row icons", () => {
  it("every disease row shows that disease's status icon — broken leg shows the broken-leg icon", () => {
    const rows = allFactRows().filter((r) => /^diseases\.[a-z_]+\.(durationSeconds|cure)$/.test(r.fact));
    expect(rows.length).toBe(15);
    for (const r of rows) {
      const key = r.fact.split(".")[1]!;
      expect(r.icon).toEqual({ kind: "condition", icon: diseaseIcon(key) });
    }
    const broken = rows.filter((r) => r.fact.startsWith("diseases.broken_leg."));
    expect(broken).toHaveLength(2);
    expect(broken.map((r) => r.label)).toEqual(["Broken Leg — lasts", "Broken Leg — cure"]);
    for (const r of broken) expect(r.icon).toEqual({ kind: "condition", icon: "broken_leg" });
  });

  it("treats rows show their pet, horse rows their mount, item-format rows their item", () => {
    expect(guideFactIcon("animals.treats.dog_lab", "items")).toEqual(guide("pet:dog_lab"));
    expect(guideFactIcon("animals.treats.cat_tabby", "items")).toEqual(guide("pet:cat_tabby"));
    expect(guideFactIcon("animals.treats.fox", "items")).toEqual(guide("pet:fox"));
    expect(guideFactIcon("animals.treats.owl", "items")).toEqual(guide("pet:owl"));
    expect(guideFactIcon("mounts.horse.walkSpeed", "speed")).toEqual(guide("mount:horse"));
    expect(guideFactIcon("mounts.horse.gallopSpeed", "speed")).toEqual(guide("mount:horse"));
    expect(guideFactIcon("mounts.harnessItem", "item")).toEqual(guide("item:harness"));
    expect(guideFactIcon("trade.currency", "item")).toEqual(guide("item:coin"));
    // saddle rows describe no single thing: no icon
    expect(guideFactIcon("mounts.saddleCount", "count")).toBeUndefined();
    expect(guideFactIcon("mounts.saddleSlots", "text")).toBeUndefined();
  });

  it("the explicit map matches, row by row", () => {
    for (const [fact, icon] of Object.entries(EXPECTED_MAP)) {
      // find the format from the shipped guide (any row using this fact)
      const row = allFactRows().find((r) => r.fact === fact)!;
      expect(row, fact).toBeDefined();
      expect(guideFactIcon(fact, row.format)).toEqual(icon);
    }
    expect(Object.keys(EXPECTED_MAP).length).toBe(40);
  });

  it("every icon the derivation returns resolves (guide keys in their defs tables, files known)", () => {
    for (const r of allFactRows()) {
      if (!r.icon) continue;
      expect(resolves(r.icon), `${r.section}:${r.fact} -> ${JSON.stringify(r.icon)}`).toBe(true);
      if (r.icon.kind === "file") expect(KNOWN_FILES.has(r.icon.file), r.icon.file).toBe(true);
      if (r.icon.kind === "condition") {
        expect(["broken_leg", "infected", "ic_snowflake.png", "ic_temp.png", "ic_health.png"]).toContain(r.icon.icon);
      }
    }
  });

  it("resolvedGuideSection attaches the same icon guideFactIcon derives", () => {
    for (const r of allFactRows()) {
      expect(r.icon).toEqual(guideFactIcon(r.fact, r.format));
    }
  });

  it("pins the coverage: 133 fact rows, 64 with icons (18 file, 15 condition, 31 guide)", () => {
    const rows = allFactRows();
    expect(rows.length).toBe(133);
    const withIcon = rows.filter((r) => r.icon);
    expect(withIcon.length).toBe(64);
    expect(withIcon.filter((r) => r.icon!.kind === "file").length).toBe(18);
    expect(withIcon.filter((r) => r.icon!.kind === "condition").length).toBe(15);
    expect(withIcon.filter((r) => r.icon!.kind === "guide").length).toBe(31);
    // rows without an icon describe a number, not a thing — spot-check the shape of the gap list
    const noIcon = rows.filter((r) => !r.icon).map((r) => r.label);
    expect(noIcon).toContain("Spring temperatures"); // no HUD season icon for spring
    expect(noIcon).toContain("Zombies expected each minute at night, per player"); // no zombie icon
    expect(noIcon).toContain("Tiers that can catch fire");
  });
});
