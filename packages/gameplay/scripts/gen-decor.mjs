// ADR-112 decor catalog generator. Regenerates the "decor" block of data/pieces.json and the matching
// sprite fallbacks (data/sprite_fallbacks.json). Run: node scripts/gen-decor.mjs && pnpm lock:ids
import { readFileSync, writeFileSync } from "node:fs";
const P = new URL("../data/pieces.json", import.meta.url), F = new URL("../data/sprite_fallbacks.json", import.meta.url);
const c = (resource, amount) => ({ resource, amount });
const MATS = {
  rustic: { tier: 1, cost: (n) => [c("planks", n)] },
  fine: { tier: 2, cost: (n) => [c("hardwood_planks", n), c("nails", Math.max(1, Math.ceil(n / 3)))] },
  luxury: { tier: 3, cost: (n) => [c("hardwood_planks", n), c("cloth", Math.max(1, Math.ceil(n / 2))), c("bronze_ingot", 1)] },
};
const out = []; const fb = {};
/** add(key, variants, base piece fields, fallback {to, tint}) */
function add(key, variants, f, fall) {
  const p = { key, placement: "free", layer: 2, tier: 1, hp: 80, solid: false, ground: true, ...f, variants: variants.length, variantNames: variants };
  if (p.placement === "edge") delete p.ground;
  out.push(p); if (fall) fb[key] = fall;
}
function mats(base, ms, variants, n, f, fall) { for (const m of ms) add(`${base}_${m}`, variants, { tier: MATS[m].tier, cost: MATS[m].cost(n), ...f }, fall); }
const MOUNT = { placement: "edge", layer: 3, rotSteps: 4, features: { mount: true }, category: "wall" };
const LIGHT = { layer: 3, light: true, fired: true, container: 1, category: "lighting" };
// ---- furniture ----
const FUR = { category: "furniture" };
mats("chair", ["rustic", "fine", "luxury"], ["plain", "slat", "padded", "armchair"], 3, { ...FUR, rotSteps: 4 }, { to: ["chair"] });
mats("stool", ["rustic", "fine"], ["round", "square", "tall"], 2, { ...FUR }, { to: ["chair"], scale: 0.8 });
mats("bench", ["rustic", "fine"], ["plain", "backed", "carved"], 4, { ...FUR, rotSteps: 4, footprint: { w: 2, h: 1 } }, { to: ["chair"] });
mats("sofa", ["fine", "luxury"], ["plain", "tufted", "leather"], 6, { ...FUR, rotSteps: 4, footprint: { w: 2, h: 1 }, hp: 150 }, { to: ["bed", "chair"], tint: "#b08060" });
mats("bed_double", ["rustic", "fine", "luxury"], ["plain", "canopy", "quilted", "fur"], 8, { ...FUR, rotSteps: 4, footprint: { w: 2, h: 2 }, hp: 200 }, { to: ["bed"] });
add("bunk_bed", ["plain", "rail", "ladder"], { ...FUR, rotSteps: 4, footprint: { w: 1, h: 2 }, hp: 180, cost: [c("planks", 10), c("cloth", 6)] }, { to: ["bed"], tint: "#c8a070" });
mats("table_dining", ["rustic", "fine", "luxury"], ["plain", "carved", "clothed"], 6, { ...FUR, rotSteps: 4, footprint: { w: 2, h: 1 }, solid: true, hp: 150 }, { to: ["table"] });
mats("table_coffee", ["rustic", "fine"], ["round", "square", "glass_top"], 3, { ...FUR, solid: true }, { to: ["table"], scale: 0.8 });
mats("table_side", ["rustic", "fine"], ["round", "square", "drawer"], 2, { ...FUR }, { to: ["table"], scale: 0.7 });
mats("desk", ["rustic", "fine"], ["plain", "writing", "drafting"], 6, { ...FUR, rotSteps: 4, footprint: { w: 2, h: 1 }, solid: true }, { to: ["table"], tint: "#a07850" });
mats("shelf", ["rustic", "fine"], ["low", "tall", "corner"], 4, { ...FUR, rotSteps: 4, container: 4, solid: true }, { to: ["shelf", "storage_box"] });
mats("bookcase", ["rustic", "fine"], ["empty", "half", "full", "ladder"], 6, { ...FUR, rotSteps: 4, container: 6, solid: true }, { to: ["shelf", "storage_box"], tint: "#8a6040" });
mats("cabinet", ["rustic", "fine"], ["plain", "glass", "painted"], 6, { ...FUR, rotSteps: 4, container: 8, solid: true, paintable: true, spoilMul: 1 }, { to: ["storage_box"] });
mats("wardrobe", ["rustic", "fine", "luxury"], ["plain", "mirrored", "carved"], 10, { ...FUR, rotSteps: 4, container: 10, footprint: { w: 2, h: 1 }, solid: true, hp: 200, features: { wardrobe: true } }, { to: ["large_chest", "storage_box"] });
mats("dresser", ["rustic", "fine"], ["plain", "mirror_top", "painted"], 8, { ...FUR, rotSteps: 4, container: 8, footprint: { w: 2, h: 1 }, solid: true }, { to: ["large_chest", "storage_box"], tint: "#b89070" });
mats("counter", ["rustic", "fine"], ["plain", "tiled", "butcher_block"], 5, { ...FUR, rotSteps: 4, container: 4, solid: true }, { to: ["market_counter", "table"] });
add("kitchen_sink", ["stone", "metal"], { ...FUR, rotSteps: 4, solid: true, tier: 2, cost: [c("stone_brick", 4), c("iron_pipe", 1)] }, { to: ["market_counter", "table"], tint: "#a0a8b0" });
add("kitchen_cupboard", ["plain", "glass", "painted"], { ...FUR, rotSteps: 4, container: 6, solid: true, paintable: true, cost: [c("planks", 6), c("nails", 2)] }, { to: ["storage_box"] });
add("pantry", ["plain", "slatted"], { ...FUR, rotSteps: 4, container: 12, spoilMul: 0.75, solid: true, tier: 2, cost: [c("hardwood_planks", 8), c("salt", 2)] }, { to: ["large_chest", "storage_box"], tint: "#c0a880" });
add("tool_bench", ["vise", "saw", "clutter"], { ...FUR, rotSteps: 4, footprint: { w: 2, h: 1 }, solid: true, cost: [c("planks", 6), c("scrap_metal", 2)] }, { to: ["workbench"] });
add("stove_iron", ["black", "enamel", "rustic"], { ...FUR, rotSteps: 4, solid: true, tier: 3, hp: 400, station: "campfire", fired: true, heat: 12, heatRadius: 3, light: true, container: 4, fuelMul: 1.5, cost: [c("iron_plate", 4), c("nails", 2)] }, { to: ["wood_stove"] });
add("cook_range", ["plain", "tiled"], { ...FUR, rotSteps: 4, solid: true, tier: 3, hp: 500, footprint: { w: 2, h: 1 }, station: "campfire", fired: true, heat: 14, heatRadius: 3, light: true, container: 6, fuelMul: 1.75, cost: [c("iron_plate", 6), c("stone_brick", 4)] }, { to: ["wood_stove", "fireplace"] });
add("clay_oven", ["dome", "brick"], { ...FUR, solid: true, tier: 2, hp: 400, station: "campfire", fired: true, heat: 10, heatRadius: 2.5, light: true, container: 4, fuelMul: 1.25, cost: [c("clay_brick", 10), c("mortar", 2)] }, { to: ["fireplace", "campfire"] });
// ---- lighting (fuel system: fired + container fuel slot) ----
add("candle", ["single", "trio", "tall"], { ...LIGHT, hp: 10, fuelMul: 0.5, cost: [c("beeswax", 1), c("thread", 1)] }, { to: ["lantern"], scale: 0.5 });
add("candelabra", ["brass", "iron", "silver"], { ...LIGHT, hp: 30, tier: 2, cost: [c("bronze_ingot", 1), c("beeswax", 2)] }, { to: ["lantern"], scale: 0.8 });
add("floor_lamp", ["shade", "oil", "brass"], { ...LIGHT, hp: 40, tier: 2, cost: [c("glass", 1), c("iron_ingot", 1), c("cloth", 1)] }, { to: ["torch_stand", "lantern"] });
add("table_lamp", ["shade", "oil"], { ...LIGHT, hp: 20, tier: 2, cost: [c("glass", 1), c("copper_ingot", 1)] }, { to: ["lantern"], scale: 0.7 });
add("chandelier", ["wood", "iron", "crystal"], { ...LIGHT, hp: 60, tier: 3, footprint: { w: 2, h: 2 }, ground: false, fuelMul: 0.75, cost: [c("iron_ingot", 3), c("glass", 2), c("beeswax", 4)] }, { to: ["lantern"], scale: 1.4 });
add("lantern_hanging", ["iron", "paper", "brass"], { ...LIGHT, hp: 30, tier: 2, cost: [c("glass", 1), c("iron_ingot", 1), c("chain_rings", 1)] }, { to: ["lantern"] });
add("wall_sconce", ["torch", "candle", "oil"], { ...MOUNT, ...LIGHT, layer: 3, category: "lighting", hp: 30, cost: [c("iron_ingot", 1), c("sticks", 1)] }, { to: ["lantern", "torch_stand"], scale: 0.7 });
add("lamp_post", ["iron", "wood", "double"], { ...LIGHT, layer: 2, solid: true, hp: 120, tier: 2, category: "outdoor", cost: [c("iron_pipe", 2), c("glass", 1), c("lamp_oil", 1)] }, { to: ["torch_stand"], scale: 1.3 });
// ---- decorations ----
const DEC = { layer: 3, category: "decor" };
add("statue", ["bust", "warrior", "angel", "deer", "bear", "abstract"], { ...DEC, layer: 2, solid: true, tier: 2, hp: 300, rotSteps: 4, cost: [c("stone_brick", 6), c("mortar", 1)] }, { to: ["pillar", "trophy_skull"], tint: "#c8c8c0" });
add("statue_large", ["hero", "horse", "obelisk"], { ...DEC, layer: 2, solid: true, tier: 3, hp: 800, rotSteps: 4, footprint: { w: 2, h: 2 }, cost: [c("stone_brick", 20), c("mortar", 4)] }, { to: ["pillar"], tint: "#c8c8c0", scale: 1.6 });
add("vase", ["tall", "round", "painted", "amphora"], { ...DEC, hp: 15, paintable: true, cost: [c("clay", 2)] }, { to: ["potted_plant"], tint: "#c87850", scale: 0.8 });
add("crate_decor", ["single", "stack", "open"], { ...DEC, layer: 2, solid: true, rotSteps: 4, cost: [c("planks", 3)] }, { to: ["storage_box"], tint: "#c8a060" });
add("barrel_decor", ["upright", "side", "water"], { ...DEC, layer: 2, solid: true, cost: [c("planks", 4), c("iron_ingot", 1)] }, { to: ["storage_box"], tint: "#906040" });
add("barrel_storage", ["oak", "iron_band"], { ...DEC, layer: 2, solid: true, container: 8, spoilMul: 0.9, cost: [c("hardwood_planks", 5), c("iron_ingot", 1)], category: "furniture" }, { to: ["storage_box"], tint: "#906040" });
add("trophy_mount", ["deer", "elk", "moose", "boar", "wolf", "bear", "bison", "rabbit"], { ...MOUNT, category: "decor", hp: 40, cost: [c("hide", 2), c("planks", 1), c("bone", 1)] }, { to: ["trophy_skull"] });
add("clan_flag", ["pole", "crossed", "tall"], { ...DEC, hp: 50, paintable: true, features: { clanTint: true }, cost: [c("cloth", 3), c("sticks", 3), c("dye", 1)] }, { to: ["banner"] });
add("sign", ["post", "hanging", "arrow", "board"], { ...DEC, rotSteps: 4, hp: 40, cost: [c("planks", 2), c("sticks", 1)] }, { to: ["windsock", "banner"], tint: "#b08850" });
add("sign_wall", ["plain", "carved"], { ...MOUNT, category: "decor", hp: 30, cost: [c("planks", 2)] }, { to: ["banner_wall"], tint: "#b08850" });
add("curtains", ["short", "long", "sheer", "heavy"], { ...MOUNT, category: "decor", hp: 20, paintable: true, cost: [c("cloth", 3), c("sticks", 1)] }, { to: ["banner_wall"] });
add("clock", ["grandfather", "mantel"], { ...DEC, layer: 2, solid: true, rotSteps: 4, tier: 3, hp: 80, cost: [c("hardwood_planks", 4), c("mechanism", 1), c("glass", 1)] }, { to: ["pillar", "mirror"], tint: "#7a5030" });
add("clock_wall", ["round", "cuckoo"], { ...MOUNT, category: "decor", tier: 3, hp: 30, cost: [c("planks", 2), c("mechanism", 1)] }, { to: ["painting", "banner_wall"] });
add("mirror_standing", ["oval", "tall"], { ...DEC, layer: 2, solid: true, rotSteps: 4, hp: 60, tier: 2, features: { wardrobe: true }, cost: [c("hardwood_planks", 3), c("glass", 2)], category: "furniture" }, { to: ["mirror"] });
add("mirror_wall", ["round", "gilded"], { ...MOUNT, hp: 30, tier: 2, features: { mount: true, wardrobe: true }, cost: [c("glass", 2), c("planks", 1)], category: "furniture" }, { to: ["mirror", "painting"] });
add("pottery", ["jug", "bowl_stack", "urn", "pitcher"], { ...DEC, hp: 15, paintable: true, cost: [c("clay", 2)] }, { to: ["potted_plant"], tint: "#b86840", scale: 0.6 });
add("books", ["stack", "open", "row"], { ...DEC, hp: 10, cost: [c("cloth", 1), c("leather", 1)] }, { to: ["storage_box"], tint: "#803030", scale: 0.4 });
add("dishes", ["plates", "cups", "set", "cutlery"], { ...DEC, hp: 10, cost: [c("clay", 1)] }, { to: ["potted_plant"], tint: "#e8e8e0", scale: 0.4 });
add("basket", ["wicker", "laundry", "fruit"], { ...DEC, hp: 15, container: 2, cost: [c("reeds", 4)], category: "furniture" }, { to: ["storage_box"], tint: "#d0b070", scale: 0.6 });
// ---- house plants ----
const PL = { layer: 3, category: "plants" };
add("plant_floor", ["fern", "palm", "ficus", "monstera", "snake_plant"], { ...PL, hp: 20, cost: [c("clay", 2), c("fiber", 2)] }, { to: ["potted_plant"], scale: 1.2 });
add("fern", ["boston", "maidenhair"], { ...PL, hp: 15, cost: [c("clay", 1), c("fiber", 2)] }, { to: ["potted_plant"], tint: "#70c070" });
add("cactus", ["barrel", "saguaro", "prickly", "flowering"], { ...PL, hp: 25, cost: [c("clay", 1), c("sand", 2)] }, { to: ["potted_plant"], tint: "#90b060" });
add("flowers_pot", ["rose", "tulip", "daisy", "lavender", "sunflower"], { ...PL, hp: 15, cost: [c("clay", 1), c("fiber", 1), c("dye", 1)] }, { to: ["flower_box", "potted_plant"], scale: 0.7 });
add("hanging_plant", ["ivy", "spider", "pearls"], { ...PL, hp: 10, ground: false, cost: [c("clay", 1), c("rope", 1), c("fiber", 1)] }, { to: ["potted_plant"], scale: 0.8 });
add("bonsai", ["pine", "maple"], { ...PL, hp: 15, tier: 2, cost: [c("clay", 2), c("fiber", 1)] }, { to: ["potted_plant"], tint: "#609050", scale: 0.6 });
add("herb_planter", ["wood", "clay", "stone"], { ...PL, layer: 2, hp: 60, features: { planter: true }, cost: [c("planks", 3), c("clay", 2)], category: "furniture" }, { to: ["flower_box"] });
add("window_planter", ["wood", "clay"], { ...MOUNT, hp: 30, features: { mount: true, planter: true }, cost: [c("planks", 2), c("clay", 1)], category: "furniture" }, { to: ["flower_box"] });
// ---- wall hangings ----
add("painting_wall", ["landscape", "portrait", "still_life", "abstract", "seascape", "battle", "map", "hunt"], { ...MOUNT, hp: 20, cost: [c("planks", 1), c("cloth", 1), c("dye", 2)] }, { to: ["painting"] });
add("poster", ["wanted", "propaganda", "band", "map", "recruit", "travel"], { ...MOUNT, hp: 5, cost: [c("fiber", 2), c("dye", 1)] }, { to: ["painting"], scale: 0.8 });
add("tapestry", ["hunt", "crest", "forest", "dragon"], { ...MOUNT, hp: 30, paintable: true, cost: [c("cloth", 4), c("dye", 2)] }, { to: ["banner_wall"] });
add("weapon_rack", ["swords", "spears", "rifles", "bows"], { ...MOUNT, hp: 60, container: 4, cost: [c("planks", 4), c("nails", 2)], category: "furniture" }, { to: ["banner_wall", "painting"], tint: "#906040" });
add("wall_shelf", ["plank", "double", "corner", "potted"], { ...MOUNT, hp: 40, container: 2, cost: [c("planks", 2), c("nails", 1)], category: "furniture" }, { to: ["painting"], tint: "#b08850" });
add("shield_mount", ["round", "kite", "clan"], { ...MOUNT, hp: 50, features: { mount: true, clanTint: true }, cost: [c("planks", 2), c("iron_ingot", 1)] }, { to: ["banner_wall"] });
add("map_board", ["region", "battle"], { ...MOUNT, hp: 20, cost: [c("planks", 2), c("cloth", 1)] }, { to: ["painting"] });
// ---- rugs: layer 1 so furniture (2) and decor (3) sit on top; variant = pattern overlay, paint = tint colour ----
const PAT = ["plain", "striped", "checker", "diamond", "floral", "border", "tribal", "braided"];
for (const [k, w, h, n] of [["rug_1x1", 1, 1, 2], ["rug_2x1", 2, 1, 3], ["rug_2x2", 2, 2, 5], ["rug_3x2", 3, 2, 7], ["rug_round", 2, 2, 5], ["rug_runner", 3, 1, 4]])
  add(k, PAT, { layer: 1, category: "rugs", hp: 30, rotSteps: 4, paintable: true, footprint: { w, h }, cost: [c("cloth", n), c("dye", 1)] }, { to: ["rug"], scale: Math.max(w, h) });
// ---- outdoor ----
const OUT = { category: "outdoor" };
add("fence_picket", ["white", "natural", "rustic"], { ...OUT, layer: 1, solid: true, blocksPath: true, rotSteps: 4, hp: 120, paintable: true, cost: [c("planks", 2), c("nails", 1)] }, { to: ["fence", "wall_low"], tint: "#e8e0d0" });
add("fence_rail", ["split", "post"], { ...OUT, layer: 1, solid: true, blocksPath: true, rotSteps: 4, hp: 100, cost: [c("wood", 2), c("rope", 1)] }, { to: ["fence", "wall_low"], tint: "#a07850" });
add("fence_iron", ["plain", "spiked"], { ...OUT, layer: 1, solid: true, blocksPath: true, rotSteps: 4, hp: 400, tier: 3, cost: [c("iron_ingot", 2)] }, { to: ["fence", "wall_low"], tint: "#505860" });
add("garden_gate", ["picket", "iron", "rustic"], { ...OUT, layer: 1, solid: true, door: true, blocksPath: true, rotSteps: 4, hp: 150, cost: [c("planks", 4), c("nails", 2)] }, { to: ["gate_clan", "door_wood"], scale: 0.6 });
add("feeding_trough", ["wood", "stone", "hay"], { ...OUT, layer: 2, solid: true, rotSteps: 4, hp: 120, container: 6, footprint: { w: 2, h: 1 }, cost: [c("planks", 4), c("nails", 2)], category: "furniture" }, { to: ["storage_box"], tint: "#a07850" }); // ADR-113 pens
add("bench_park", ["wood", "iron", "stone"], { ...OUT, rotSteps: 4, footprint: { w: 2, h: 1 }, hp: 150, cost: [c("planks", 4), c("iron_ingot", 1)] }, { to: ["chair"] });
add("planter_box", ["long", "square", "raised"], { ...OUT, hp: 60, features: { planter: true }, cost: [c("planks", 4), c("clay", 1)], category: "furniture" }, { to: ["flower_box"] });
add("garden_bed", ["raised", "stone"], { ...OUT, layer: 1, hp: 80, footprint: { w: 2, h: 1 }, features: { planter: true }, cost: [c("planks", 6)], category: "furniture" }, { to: ["flower_box"], scale: 1.5 });
add("fountain", ["tiered", "round", "lion"], { ...OUT, solid: true, tier: 3, hp: 600, footprint: { w: 2, h: 2 }, cost: [c("stone_brick", 16), c("mortar", 4), c("iron_pipe", 2)] }, { to: ["campfire", "pillar"], tint: "#a0c0e0", scale: 1.6 });
add("well", ["stone", "roofed"], { ...OUT, solid: true, tier: 2, hp: 500, footprint: { w: 2, h: 2 }, cost: [c("stone_brick", 12), c("rope", 2), c("planks", 4)] }, { to: ["campfire", "pillar"], tint: "#909090", scale: 1.5 });
add("scarecrow", ["classic", "pumpkin", "tattered"], { ...OUT, hp: 60, cost: [c("sticks", 4), c("cloth", 2), c("fiber", 4)] }, { to: ["windsock", "banner"], tint: "#d0b070" });
add("path_stone", ["cobble", "flagstone", "gravel", "brick", "plank"], { ...OUT, layer: 1, hp: 200, cost: [c("stone", 2)] }, { to: ["rug"], tint: "#a09890" });
add("stepping_stone", ["round", "slate"], { ...OUT, layer: 1, hp: 200, cost: [c("stone", 1)] }, { to: ["rug"], tint: "#908880", scale: 0.6 });
add("hedge", ["box", "round", "tall"], { ...OUT, solid: true, blocksPath: true, hp: 120, cost: [c("fiber", 6), c("sticks", 2)] }, { to: ["potted_plant"], tint: "#408040", scale: 1.5 });
add("flower_bed", ["red", "yellow", "mixed", "wild"], { ...OUT, layer: 1, hp: 30, cost: [c("fiber", 3), c("clay", 1)] }, { to: ["flower_box"], scale: 1.2 });
add("birdbath", ["stone", "copper"], { ...OUT, hp: 150, cost: [c("stone_brick", 3)] }, { to: ["pillar"], tint: "#b0b8c0", scale: 0.7 });
add("sundial", ["stone", "bronze"], { ...OUT, hp: 150, tier: 2, cost: [c("stone_brick", 2), c("bronze_ingot", 1)] }, { to: ["pillar"], tint: "#c0a060", scale: 0.6 });

// art-less pre-ADR-112 pieces used as fallback targets above: terminate every chain at a piece the pack has
Object.assign(fb, {
  lantern: { to: ["bonfire"], tint: "#ffd890", scale: 0.4 }, torch_stand: { to: ["bonfire"], scale: 0.6 },
  banner: { to: ["painting"], tint: "#c04040" }, banner_wall: { to: ["painting"], tint: "#c04040" }, windsock: { to: ["pillar"], tint: "#d0d0d0", scale: 0.8 },
  mirror: { to: ["painting"], tint: "#d0e0f0" }, wood_stove: { to: ["furnace"], scale: 0.8 }, fireplace: { to: ["furnace"], tint: "#c09080" },
  campfire: { to: ["bonfire"] }, market_counter: { to: ["table"], tint: "#b08850" }, gate_clan: { to: ["door_wood"] },
});
const pj = JSON.parse(readFileSync(P, "utf8"));
const keys = new Set(out.map((p) => p.key));
pj.pieces = [...pj.pieces.filter((p) => !p.$decor && !keys.has(p.key)), ...out.map((p) => ({ ...p, $decor: true }))];
writeFileSync(P, JSON.stringify(pj, null, 2) + "\n");
const fj = JSON.parse(readFileSync(F, "utf8"));
for (const [k, v] of Object.entries(fb)) fj.sprites[k] = v;
writeFileSync(F, JSON.stringify(fj, null, 2) + "\n");
const nv = out.reduce((s, p) => s + p.variants, 0);
console.log(`decor pieces ${out.length}, variants ${nv}`);
