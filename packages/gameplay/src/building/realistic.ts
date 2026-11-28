/**
 * ADR-593: realistic generated buildings. Each kind is a real-world floor plan written as rooms that tile every floor of
 * every block (1 tile = 1 m, 5 terrain levels = one 80 px floor). Everything else is derived, so the rules hold for
 * every kind: exterior walls with an L corner piece at each corner; an interior partition on every edge between two
 * different rooms; a door (or archway, or nothing for an open plan) where two rooms are linked; exterior doors where
 * the plan's entries say; windows only on exterior walls, spaced by room type (none in a vault or a cell block, a glass
 * storefront along a shop's front); a flight of stairs with its stairwell hole and landing on the floor above; a roof
 * styled per block. Furniture and loot come from the room type (a kitchen gets cupboards, sink, stove and a table; a
 * classroom rows of desks; a shop aisles of shelving) and are seated by a deterministic placer that keeps every doorway,
 * stair entry and landing clear and every door of a room reachable from every other.
 *
 * Pure: no world, no randomness. A kind's layout is built once and cached; abandoned.ts rotates it and stamps it with the
 * same pump, retries, fallback, loot and ownership rules as the older kinds. Only existing piece art is used.
 */
import piecesJson from "../../data/pieces.json";

export type RRole = "deck" | "wall" | "opening" | "stair" | "furniture" | "fence" | "garden" | "loot" | "roof";
/** x / y: edge midpoint (walls, openings), tile centre (decks, stairs, roofs), footprint centre (furniture). rot: quarter turns. */
export interface RSpec { key: string; x: number; y: number; level: number; rot: number; role: RRole; exterior?: boolean }
export type RSide = "n" | "s" | "e" | "w";
export type RoomType =
  | "living" | "kitchen" | "dining" | "bed" | "kids" | "bath" | "hall" | "office" | "shop" | "store" | "bay" | "diner"
  | "class" | "nave" | "ward" | "lobby" | "cell" | "vault" | "stacks" | "bunks" | "mess" | "floor" | "plant" | "radio"
  | "lamp" | "loft" | "stalls" | "pharmacy" | "bins" | "motel" | "armory" | "laundry" | "canopy" | "teller" | "lodge"
  | "studio" | "chancel";
export interface Room { t: RoomType; x: number; y: number; w: number; h: number; l: number }
type LinkKind = "door" | "arch" | "open" | "metal";
interface Link { a: number; b: number; k: LinkKind; at?: number }
interface Entry { r: number; side: RSide; at?: number; span?: number; k?: "wood" | "metal" | "glass" }
interface Item { k: string; x: number; y: number; l?: number; r?: number; role?: RRole }
export type RoofKind = "flat" | "gable" | "hip" | "eaves" | "gambrel" | "shed";
interface Block {
  x: number; y: number; w: number; h: number; stories: number;
  rooms: Room[]; links?: Link[]; entries?: Entry[];
  /** A flight at tile (x, y) on floor l climbs north: entered from (x, y+1), lands on (x, y-1) of floor l+1, hole above (x, y). */
  stairs?: { x: number; y: number; l: number }[];
  roof: RoofKind; win?: string; door?: string;
  /** Explicit furnishings (tile anchor = top-left tile of the footprint at that rotation, block-local). */
  items?: Item[];
  /** Open canopy: corner posts, open frames on every side, a flat roof — no walls or doors. */
  canopy?: boolean;
  /** Structural columns (tile, block-local) on every floor: what carries a wide floor or roof span in a real barn, hall or nave. */
  posts?: [number, number][];
}
export type Setting = "town" | "plains" | "forest" | "mountain" | "coast";
export interface KindDef {
  key: string; w: number; h: number; tier: number; roof: RoofKind;
  blocks: Block[];
  /** Site-local outdoor pieces (lamp posts, benches, wells, signs, troughs). */
  outdoor?: Item[];
  /** Site-local rectangles paved with path_stone (forecourts, parking, front walks). */
  pave?: [number, number, number, number][];
  fence?: { x: number; y: number; w: number; h: number; key: string; gate: RSide };
  garden?: boolean; pen?: boolean;
  /** Where the settlement planner may put it, with a weight per setting. */
  where: Partial<Record<Setting, number>>;
}
export interface RBuilt { w: number; h: number; stories: number; garden: boolean; pen: boolean; pieces: RSpec[]; rooms: (Room & { block: number })[]; roof: RoofKind; tier: number }

// ---------------------------------------------------------------------------------------------------------------------
// piece facts (footprint, free rotation steps) straight from the piece table

interface PieceFacts { w: number; h: number; steps: number; free: boolean }
const FACTS = new Map<string, PieceFacts>();
for (const p of (piecesJson as unknown as { pieces: { key: string; placement?: string; footprint?: { w: number; h: number }; rotSteps?: number }[] }).pieces) {
  if (!p || typeof p !== "object" || !p.key) continue;
  FACTS.set(p.key, { w: p.footprint?.w ?? 1, h: p.footprint?.h ?? 1, steps: p.rotSteps ?? 16, free: p.placement === "free" });
}
export function pieceFacts(key: string): PieceFacts | undefined { return FACTS.get(key); }
/** Spec rotation (quarter turns) -> the piece's own rotation steps (free pieces use rotSteps, default 16). */
export function quarterToSteps(key: string, q: number): number {
  const f = FACTS.get(key); if (!f || !f.free) return q & 3;
  return ((q & 3) * f.steps / 4) | 0;
}

/** Containers a ruin fills with loot (the rest of the furniture stands empty). */
export const LOOT_KEYS: ReadonlySet<string> = new Set([
  "storage_box", "basic_storage_box", "large_chest", "barrel_storage", "salt_barrel", "wardrobe_rustic", "wardrobe_fine",
  "dresser_rustic", "dresser_fine", "cabinet_rustic", "cabinet_fine", "kitchen_cupboard", "pantry", "crop_store",
  "ore_store", "log_store", "stick_store", "stone_store", "cold_store", "curing_box",
]);
const roleOf = (key: string): RRole => (LOOT_KEYS.has(key) ? "loot" : "furniture");

// ---------------------------------------------------------------------------------------------------------------------
// room programmes: windows and furnishings per room type

type WinRule = "spaced" | "one" | "none" | "store" | "all";
const WINDOWS: Record<RoomType, WinRule> = {
  living: "spaced", kitchen: "spaced", dining: "spaced", bed: "spaced", kids: "spaced", bath: "one", hall: "one",
  office: "spaced", shop: "store", store: "none", bay: "one", diner: "store", class: "spaced", nave: "spaced", ward: "spaced",
  lobby: "store", cell: "one", vault: "none", stacks: "spaced", bunks: "spaced", mess: "spaced", floor: "spaced",
  plant: "spaced", radio: "spaced", lamp: "all", loft: "one", stalls: "one", pharmacy: "store", bins: "none", motel: "one",
  armory: "none", laundry: "one", canopy: "none", teller: "store", lodge: "spaced", studio: "spaced", chancel: "spaced",
};

/**
 * Furnishings per room type. `wall`: seated against the walls (perimeter tiles), in order, while they fit. `mid`: away from
 * the walls. `aisle`: shelving units filling every other column inside the room (shops, stacks, stores, plants).
 * `rows`: rows of the key across the room, every other row, a centre aisle kept (pews, desks, beds).
 */
interface Programme { wall?: string[]; mid?: string[]; aisle?: string; rows?: string; fill?: number }
const PROGRAMME: Record<RoomType, Programme> = {
  living: { wall: ["sofa_fine", "bookcase_rustic", "floor_lamp", "chair_fine", "cabinet_fine", "potted_plant"], mid: ["table_coffee_rustic"] },
  kitchen: { wall: ["kitchen_cupboard", "kitchen_sink", "stove_iron", "kitchen_cupboard", "pantry", "counter_rustic"], mid: ["table_dining_rustic", "chair_rustic", "chair_rustic"] },
  dining: { wall: ["cabinet_fine", "potted_plant"], mid: ["table_dining_fine", "chair_fine", "chair_fine", "chair_fine"] },
  bed: { wall: ["bed_double_rustic", "wardrobe_rustic", "table_side_rustic", "dresser_rustic", "floor_lamp"] },
  kids: { wall: ["bunk_bed", "storage_box", "desk_rustic", "chair_rustic", "shelf_rustic"] },
  bath: { wall: ["kitchen_sink", "cabinet_rustic", "mirror_standing"] },
  hall: { wall: ["potted_plant", "clock"], fill: 0.15 },
  office: { wall: ["desk_rustic", "cabinet_rustic", "bookcase_rustic", "chair_rustic", "table_lamp"] },
  shop: { wall: ["counter_rustic", "cabinet_rustic", "storage_box"], aisle: "shelf_rustic" },
  store: { wall: ["storage_box", "large_chest", "barrel_storage", "crate_decor", "shelf_rustic", "barrel_decor", "storage_box"] },
  bay: { wall: ["tool_bench", "workbench", "barrel_storage", "crate_decor", "barrel_decor"], fill: 0.3 },
  diner: { wall: ["counter_rustic", "counter_rustic", "counter_rustic", "bench_rustic", "bench_rustic"], mid: ["table_dining_rustic", "stool_rustic", "stool_rustic", "table_dining_rustic", "chair_rustic", "chair_rustic"] },
  class: { wall: ["desk_fine", "bookcase_rustic", "cabinet_rustic"], rows: "desk_rustic" },
  nave: { rows: "bench_rustic", wall: ["candelabra", "candelabra"] },
  ward: { wall: ["bed", "bed", "table_side_fine", "bed", "cabinet_fine", "bed"] },
  lobby: { wall: ["counter_fine", "sofa_fine", "potted_plant", "chair_fine", "table_side_fine"] },
  cell: { wall: ["bed"] },
  vault: { wall: ["large_chest", "large_chest", "storage_box", "storage_box"] },
  stacks: { wall: ["table_dining_fine", "chair_fine", "chair_fine", "bookcase_fine"], aisle: "bookcase_fine" },
  bunks: { wall: ["bunk_bed", "bunk_bed", "storage_box", "bunk_bed", "storage_box", "bunk_bed"] },
  mess: { wall: ["counter_rustic", "stove_iron", "kitchen_cupboard"], mid: ["table_dining_rustic", "bench_rustic", "bench_rustic"] },
  floor: { wall: ["large_chest", "storage_box", "barrel_storage"], aisle: "crate_decor" },
  plant: { wall: ["furnace", "anvil", "tool_bench", "workbench", "barrel_storage", "furnace"], aisle: "barrel_decor" },
  radio: { wall: ["desk_rustic", "chair_rustic", "cabinet_rustic", "table_lamp", "clock"] },
  lamp: { mid: ["lantern"] },
  loft: { wall: ["crop_store", "stick_store", "log_store", "crop_store"] },
  stalls: { wall: ["feeding_trough", "feeding_trough", "pet_trough", "barrel_storage"] },
  pharmacy: { wall: ["counter_fine", "cabinet_fine", "cabinet_fine", "storage_box"], aisle: "shelf_fine" },
  bins: { wall: ["crop_store", "crop_store", "crop_store"] },
  motel: { wall: ["bed_double_rustic", "table_side_rustic", "chair_rustic", "dresser_rustic"] },
  armory: { wall: ["large_chest", "storage_box", "barrel_storage"] },
  laundry: { wall: ["kitchen_sink", "basket", "cabinet_rustic"] },
  canopy: {},
  teller: { wall: ["counter_fine", "counter_fine", "chair_fine", "desk_fine"] },
  lodge: { wall: ["fireplace", "sofa_fine", "bookcase_rustic", "chair_rustic"], mid: ["table_dining_rustic", "chair_rustic", "chair_rustic"] },
  studio: { wall: ["bed", "kitchen_cupboard", "stove_iron", "wardrobe_rustic", "kitchen_sink"], mid: ["table", "chair"] },
  chancel: { mid: ["table_dining_fine"], wall: ["candelabra", "statue", "candelabra"] },
};

// ---------------------------------------------------------------------------------------------------------------------
// the catalogue

const R = (t: RoomType, x: number, y: number, w: number, h: number, l = 0): Room => ({ t, x, y, w, h, l });
const L = (a: number, b: number, k: LinkKind = "door", at?: number): Link => (at === undefined ? { a, b, k } : { a, b, k, at });

/** Mirror a block's rooms / links / stairs / entries / items across its vertical axis (the second unit of a duplex). */
function mirrorRooms(rooms: Room[], w: number, dx: number): Room[] { return rooms.map((r) => ({ ...r, x: dx + w - r.x - r.w })); }

const apartmentFloor = (l: number, ground: boolean): Room[] => [
  // two units north of the corridor, two south (the ground floor's south-west unit is the lobby)
  R("studio", 0, 0, 4, 4, l), R("bath", 4, 0, 2, 2, l), R("bed", 4, 2, 2, 2, l),
  R("studio", 8, 0, 4, 4, l), R("bath", 6, 0, 2, 2, l), R("bed", 6, 2, 2, 2, l),
  R("hall", 0, 4, 12, 3, l),
  ...(ground ? [R("lobby", 0, 7, 6, 4, l)] : [R("studio", 0, 7, 4, 4, l), R("bath", 4, 7, 2, 2, l), R("bed", 4, 9, 2, 2, l)]),
  R("studio", 8, 7, 4, 4, l), R("bath", 6, 7, 2, 2, l), R("bed", 6, 9, 2, 2, l),
];
function apartmentLinks(ground: boolean): Link[] {
  // indices follow apartmentFloor: 0..2 unit NW, 3..5 unit NE, 6 corridor, then SW (lobby or 7..9), then SE
  const se = ground ? 8 : 10;
  const out: Link[] = [L(0, 1), L(0, 2), L(3, 4), L(3, 5), L(6, 0), L(6, 3), L(6, se)];
  out.push(L(se, se + 1), L(se, se + 2));
  if (ground) out.push(L(6, 7, "arch")); else out.push(L(7, 8), L(7, 9), L(6, 7));
  return out;
}

export const REALISTIC_KINDS: readonly KindDef[] = [
  // Single-storey ranch: bedrooms + bath off a back hall, open living / dining / kitchen across the front, side kitchen door.
  { key: "ranch_house", w: 13, h: 10, tier: 1, roof: "hip", where: { plains: 7, forest: 2, town: 3 },
    blocks: [{ x: 0, y: 0, w: 13, h: 8, stories: 1, roof: "hip",
      rooms: [R("bed", 0, 0, 4, 3), R("bath", 4, 0, 2, 3), R("kids", 6, 0, 3, 3), R("bed", 9, 0, 4, 3), R("hall", 0, 3, 13, 1), R("living", 0, 4, 6, 4), R("dining", 6, 4, 3, 4), R("kitchen", 9, 4, 4, 4)],
      links: [L(4, 0), L(4, 1), L(4, 2), L(4, 3), L(4, 5, "open"), L(4, 6, "open"), L(5, 6, "open"), L(6, 7, "open")],
      entries: [{ r: 5, side: "s", at: 3 }, { r: 7, side: "e", at: 2 }] }],
    pave: [[3, 8, 1, 2]], outdoor: [{ k: "sign", x: 5, y: 9 }] },
  // Two-storey centre-hall house: foyer + stair, living left, kitchen / dining right, three bedrooms + bath upstairs.
  { key: "suburban_house", w: 10, h: 11, tier: 1, roof: "gable", where: { town: 9, plains: 2 },
    blocks: [{ x: 0, y: 0, w: 10, h: 8, stories: 2, roof: "gable", stairs: [{ x: 4, y: 4, l: 0 }],
      rooms: [R("bath", 0, 0, 2, 2), R("laundry", 2, 0, 2, 2), R("living", 0, 2, 4, 6), R("hall", 4, 0, 2, 8), R("kitchen", 6, 0, 4, 4), R("dining", 6, 4, 4, 4),
        R("bed", 0, 0, 4, 5, 1), R("kids", 0, 5, 4, 3, 1), R("hall", 4, 0, 2, 8, 1), R("bed", 6, 0, 4, 4, 1), R("bath", 6, 4, 4, 2, 1), R("kids", 6, 6, 4, 2, 1)],
      links: [L(3, 2, "open"), L(2, 0), L(3, 1), L(3, 4, "arch"), L(3, 5, "arch"), L(4, 5, "open"), L(8, 6), L(8, 7), L(8, 9), L(8, 10), L(8, 11)],
      entries: [{ r: 3, side: "s", at: 1 }, { r: 3, side: "n", at: 1 }] }],
    pave: [[5, 8, 1, 3]], outdoor: [{ k: "hedge", x: 1, y: 9 }, { k: "hedge", x: 2, y: 9 }, { k: "hedge", x: 8, y: 9 }, { k: "sign", x: 7, y: 10 }] },
  // Side-by-side duplex: two mirrored two-storey units behind a shared party wall.
  { key: "duplex", w: 14, h: 9, tier: 1, roof: "gable", where: { town: 6 },
    blocks: [{ x: 0, y: 0, w: 14, h: 7, stories: 2, roof: "gable", stairs: [{ x: 5, y: 4, l: 0 }, { x: 8, y: 4, l: 0 }],
      rooms: [
        R("kitchen", 0, 0, 3, 3), R("bath", 3, 0, 2, 3), R("living", 0, 3, 5, 4), R("hall", 5, 0, 2, 7),
        ...mirrorRooms([R("kitchen", 0, 0, 3, 3), R("bath", 3, 0, 2, 3), R("living", 0, 3, 5, 4), R("hall", 5, 0, 2, 7)], 7, 7),
        R("bed", 0, 0, 5, 4, 1), R("bath", 0, 4, 2, 3, 1), R("kids", 2, 4, 3, 3, 1), R("hall", 5, 0, 2, 7, 1),
        ...mirrorRooms([R("bed", 0, 0, 5, 4, 1), R("bath", 0, 4, 2, 3, 1), R("kids", 2, 4, 3, 3, 1), R("hall", 5, 0, 2, 7, 1)], 7, 7),
      ],
      links: [L(2, 0, "open"), L(3, 1), L(3, 2, "open"), L(6, 4, "open"), L(7, 5), L(7, 6, "open"),
        L(11, 8), L(11, 10), L(9, 8), L(15, 12), L(15, 14), L(13, 12)],
      entries: [{ r: 3, side: "s", at: 1 }, { r: 7, side: "s", at: 0 }] }],
    pave: [[6, 7, 2, 2]], outdoor: [{ k: "hedge", x: 2, y: 8 }, { k: "hedge", x: 11, y: 8 }] },
  // Three-storey walk-up: corridor with a stair core, two studio flats either side, a lobby on the ground floor.
  { key: "apartment_block", w: 12, h: 14, tier: 2, roof: "flat", where: { town: 3 },
    blocks: [{ x: 0, y: 0, w: 12, h: 11, stories: 3, roof: "flat", win: "window_glass", door: "door_metal",
      stairs: [{ x: 11, y: 5, l: 0 }, { x: 10, y: 5, l: 1 }],
      rooms: [...apartmentFloor(0, true), ...apartmentFloor(1, false), ...apartmentFloor(2, false)],
      links: [...apartmentLinks(true), ...apartmentLinks(false).map((k) => ({ ...k, a: k.a + 11, b: k.b + 11 })), ...apartmentLinks(false).map((k) => ({ ...k, a: k.a + 24, b: k.b + 24 }))],
      entries: [{ r: 7, side: "s", at: 2, span: 2, k: "glass" }] }],
    pave: [[2, 11, 2, 3]], outdoor: [{ k: "lamp_post", x: 1, y: 12 }, { k: "lamp_post", x: 5, y: 12 }, { k: "bench_park", x: 7, y: 12 }] },
  // Gas station: kiosk (sales floor, stockroom, restroom) behind a fuel canopy over the forecourt.
  { key: "gas_station", w: 10, h: 13, tier: 2, roof: "flat", where: { town: 3, plains: 4, coast: 4, forest: 2 },
    blocks: [
      { x: 0, y: 0, w: 8, h: 6, stories: 1, roof: "flat", win: "window_glass", door: "door_metal",
        rooms: [R("shop", 0, 0, 5, 6), R("store", 5, 0, 3, 3), R("bath", 5, 3, 3, 3)],
        links: [L(0, 1), L(0, 2)], entries: [{ r: 0, side: "s", at: 2, k: "glass" }, { r: 1, side: "n", at: 1 }] },
      { x: 1, y: 8, w: 7, h: 4, stories: 1, roof: "flat", canopy: true, rooms: [R("canopy", 0, 0, 7, 4)],
        items: [{ k: "barrel_decor", x: 2, y: 1 }, { k: "barrel_decor", x: 4, y: 2 }] },
    ],
    pave: [[2, 6, 4, 2], [0, 12, 10, 1]], outdoor: [{ k: "sign", x: 9, y: 7 }, { k: "lamp_post", x: 9, y: 11 }] },
  // Roadside diner: booths along the front glass, counter + stools, kitchen, stockroom and two restrooms behind.
  { key: "diner", w: 12, h: 11, tier: 2, roof: "flat", where: { town: 3, plains: 3, coast: 3, forest: 1 },
    blocks: [{ x: 0, y: 0, w: 12, h: 8, stories: 1, roof: "flat", win: "window_glass",
      rooms: [R("kitchen", 0, 0, 6, 3), R("store", 6, 0, 2, 3), R("bath", 8, 0, 2, 3), R("bath", 10, 0, 2, 3), R("diner", 0, 3, 12, 5)],
      links: [L(4, 0), L(0, 1), L(4, 2), L(4, 3)], entries: [{ r: 4, side: "s", at: 5, k: "glass" }, { r: 0, side: "n", at: 2 }] }],
    pave: [[0, 8, 12, 2]], outdoor: [{ k: "sign", x: 11, y: 10 }, { k: "lamp_post", x: 0, y: 10 }] },
  // Corner convenience store: sales floor with aisles, checkout, stockroom and a staff restroom.
  { key: "convenience_store", w: 9, h: 9, tier: 2, roof: "flat", where: { town: 3 },
    blocks: [{ x: 0, y: 0, w: 9, h: 7, stories: 1, roof: "flat", win: "window_glass", door: "door_metal",
      rooms: [R("shop", 0, 2, 9, 5), R("store", 0, 0, 6, 2), R("bath", 6, 0, 3, 2)],
      links: [L(0, 1), L(0, 2)], entries: [{ r: 0, side: "s", at: 4, k: "glass" }] }],
    pave: [[0, 7, 9, 2]], outdoor: [{ k: "lamp_post", x: 8, y: 8 }] },
  // Grocery store: wide sales floor with long aisles, checkout lanes, produce cold room, stockroom, office.
  { key: "grocery_store", w: 16, h: 13, tier: 2, roof: "flat", where: { town: 2 },
    blocks: [{ x: 0, y: 0, w: 16, h: 10, stories: 1, roof: "flat", win: "window_glass", door: "door_metal", posts: [[4, 6], [8, 6], [12, 6]],
      rooms: [R("store", 0, 0, 7, 3), R("store", 7, 0, 5, 3), R("office", 12, 0, 2, 3), R("bath", 14, 0, 2, 3), R("shop", 0, 3, 16, 7)],
      links: [L(4, 0, "arch"), L(4, 1, "metal"), L(4, 2), L(4, 3), L(0, 1, "arch")],
      entries: [{ r: 4, side: "s", at: 3, span: 2, k: "glass" }, { r: 4, side: "s", at: 11, k: "glass" }, { r: 0, side: "n", at: 2, k: "metal" }] }],
    pave: [[0, 10, 16, 3]], outdoor: [{ k: "lamp_post", x: 0, y: 12 }, { k: "lamp_post", x: 15, y: 12 }, { k: "sign", x: 8, y: 12 }] },
  // Motor-court motel: a row of rooms, each with its own door to the lot and a bathroom at the back, office at one end.
  { key: "motel", w: 17, h: 9, tier: 1, roof: "flat", where: { town: 2, plains: 3, coast: 3, forest: 1 },
    blocks: [{ x: 0, y: 0, w: 17, h: 6, stories: 1, roof: "flat", win: "window_glass",
      rooms: [R("lobby", 0, 0, 4, 6), R("bath", 4, 0, 3, 2), R("motel", 4, 2, 3, 4), R("bath", 7, 0, 3, 2), R("motel", 7, 2, 3, 4), R("bath", 10, 0, 3, 2), R("motel", 10, 2, 3, 4), R("bath", 13, 0, 4, 2), R("motel", 13, 2, 4, 4)],
      links: [L(2, 1), L(4, 3), L(6, 5), L(8, 7)],
      entries: [{ r: 0, side: "s", at: 2, k: "glass" }, { r: 2, side: "s", at: 1 }, { r: 4, side: "s", at: 1 }, { r: 6, side: "s", at: 1 }, { r: 8, side: "s", at: 2 }] }],
    pave: [[0, 6, 17, 2]], outdoor: [{ k: "sign", x: 0, y: 8 }, { k: "lamp_post", x: 8, y: 8 }] },
  // Parish church: nave with pews either side of the aisle, chancel with altar, vestry, narthex at the door.
  { key: "church", w: 9, h: 15, tier: 2, roof: "gable", where: { town: 2, plains: 2, forest: 1 },
    blocks: [{ x: 0, y: 0, w: 9, h: 14, stories: 1, roof: "gable", win: "window_glass", posts: [[3, 5], [5, 5], [3, 8], [5, 8]],
      rooms: [R("nave", 0, 3, 9, 8), R("office", 0, 0, 3, 3), R("chancel", 3, 0, 6, 3), R("lobby", 0, 11, 9, 3)],
      links: [L(0, 2, "arch"), L(1, 2), L(0, 3, "arch", 1)], entries: [{ r: 3, side: "s", at: 4, span: 1 }] }],
    pave: [[4, 14, 1, 1]] },
  // School: double-loaded corridor, four classrooms, office, restrooms; front entrance into the corridor.
  { key: "school", w: 18, h: 13, tier: 2, roof: "hip", where: { town: 2, plains: 1 },
    blocks: [{ x: 0, y: 0, w: 18, h: 11, stories: 1, roof: "hip", win: "window_glass",
      rooms: [R("class", 0, 0, 6, 5), R("class", 6, 0, 6, 5), R("class", 12, 0, 6, 5), R("hall", 0, 5, 18, 2), R("class", 0, 7, 6, 4), R("office", 6, 7, 3, 4), R("lobby", 9, 7, 3, 4), R("bath", 12, 7, 3, 4), R("class", 15, 7, 3, 4)],
      links: [L(3, 0), L(3, 1), L(3, 2), L(3, 4), L(3, 5), L(3, 6, "open"), L(3, 7), L(3, 8), L(6, 5)],
      entries: [{ r: 6, side: "s", at: 1 }] }],
    pave: [[9, 11, 3, 2]], outdoor: [{ k: "bench_park", x: 1, y: 12 }, { k: "bench_park", x: 14, y: 12 }, { k: "sign", x: 13, y: 11 }] },
  // Fire station: two-bay apparatus floor with wide doors, watch office, bunk room, kitchen / day room, bunks upstairs.
  { key: "fire_station", w: 13, h: 12, tier: 2, roof: "flat", where: { town: 2 },
    blocks: [{ x: 0, y: 0, w: 13, h: 9, stories: 2, roof: "flat", win: "window_glass", door: "door_metal",
      stairs: [{ x: 10, y: 4, l: 0 }], posts: [[4, 2], [4, 4], [4, 6], [2, 4], [6, 4]],
      rooms: [R("bay", 0, 0, 9, 9), R("mess", 9, 0, 4, 3), R("hall", 9, 3, 4, 3), R("office", 9, 6, 4, 3),
        R("bunks", 0, 0, 9, 9, 1), R("bath", 9, 0, 4, 3, 1), R("hall", 9, 3, 4, 3, 1), R("store", 9, 6, 4, 3, 1)],
      links: [L(0, 2, "metal"), L(2, 1, "open"), L(2, 3), L(6, 4), L(6, 5), L(6, 7)],
      entries: [{ r: 0, side: "s", at: 1, span: 3, k: "metal" }, { r: 0, side: "s", at: 5, span: 3, k: "metal" }, { r: 3, side: "s", at: 2 }] }],
    pave: [[0, 9, 9, 3]], outdoor: [{ k: "lamp_post", x: 10, y: 10 }, { k: "sign", x: 12, y: 10 }] },
  // Police station: lobby with front desk, offices, squad room, armoury, a barred cell block behind steel doors.
  { key: "police_station", w: 13, h: 11, tier: 3, roof: "flat", where: { town: 2 },
    blocks: [{ x: 0, y: 0, w: 13, h: 9, stories: 1, roof: "flat", win: "window_bars", door: "door_metal",
      rooms: [R("cell", 0, 0, 3, 3), R("cell", 3, 0, 3, 3), R("hall", 0, 3, 6, 1), R("armory", 6, 0, 3, 4), R("office", 9, 0, 4, 4), R("office", 0, 4, 4, 5), R("hall", 4, 4, 9, 1), R("lobby", 4, 5, 6, 4), R("bath", 10, 5, 3, 4)],
      links: [L(2, 0, "metal"), L(2, 1, "metal"), L(6, 2, "metal"), L(6, 3, "metal"), L(6, 4), L(6, 5), L(6, 7, "open"), L(6, 8)],
      entries: [{ r: 7, side: "s", at: 2 }] }],
    pave: [[4, 9, 6, 2]], outdoor: [{ k: "lamp_post", x: 3, y: 10 }, { k: "lamp_post", x: 11, y: 10 }] },
  // Walk-in clinic: waiting room + reception, exam rooms off a corridor, ward, dispensary, staff room.
  { key: "clinic", w: 12, h: 11, tier: 2, roof: "flat", where: { town: 2 },
    blocks: [{ x: 0, y: 0, w: 12, h: 9, stories: 1, roof: "flat", win: "window_glass",
      rooms: [R("ward", 0, 0, 6, 4), R("office", 6, 0, 3, 4), R("pharmacy", 9, 0, 3, 4), R("hall", 0, 4, 12, 1), R("lobby", 0, 5, 6, 4), R("ward", 6, 5, 3, 4), R("bath", 9, 5, 3, 4)],
      links: [L(3, 0), L(3, 1), L(3, 2), L(3, 4, "open"), L(3, 5), L(3, 6)], entries: [{ r: 4, side: "s", at: 2, k: "glass" }] }],
    pave: [[0, 9, 6, 2]], outdoor: [{ k: "bench_park", x: 7, y: 10 }] },
  // Pharmacy: aisles up front, prescription counter and dispensary at the back, stockroom.
  { key: "pharmacy", w: 9, h: 10, tier: 2, roof: "flat", where: { town: 2 },
    blocks: [{ x: 0, y: 0, w: 9, h: 8, stories: 1, roof: "flat", win: "window_glass", door: "door_metal",
      rooms: [R("pharmacy", 0, 0, 5, 3), R("store", 5, 0, 4, 3), R("shop", 0, 3, 9, 5)],
      links: [L(2, 0, "arch"), L(0, 1)], entries: [{ r: 2, side: "s", at: 4, k: "glass" }] }],
    pave: [[0, 8, 9, 2]] },
  // Hardware store: long sales floor with racking, a lumber / garden yard behind a fence.
  { key: "hardware_store", w: 12, h: 15, tier: 2, roof: "flat", where: { town: 2 },
    blocks: [{ x: 0, y: 4, w: 12, h: 9, stories: 1, roof: "flat", win: "window_glass", door: "door_metal", posts: [[4, 5], [8, 5]],
      rooms: [R("store", 0, 0, 8, 2), R("office", 8, 0, 4, 2), R("shop", 0, 2, 12, 7)],
      links: [L(2, 0, "arch"), L(2, 1)], entries: [{ r: 2, side: "s", at: 5, k: "glass" }, { r: 0, side: "n", at: 3, k: "metal" }] }],
    fence: { x: 0, y: 0, w: 12, h: 4, key: "fence_rail", gate: "w" },
    outdoor: [{ k: "log_store", x: 2, y: 1, role: "loot" }, { k: "stone_store", x: 5, y: 1, role: "loot" }, { k: "stick_store", x: 8, y: 1, role: "loot" }],
    pave: [[0, 13, 12, 2]] },
  // Bank: banking hall with teller counters, manager's office, a steel-doored vault with no windows.
  { key: "bank", w: 11, h: 10, tier: 3, roof: "flat", where: { town: 2 },
    blocks: [{ x: 0, y: 0, w: 11, h: 8, stories: 1, roof: "flat", win: "window_bars", door: "door_metal",
      rooms: [R("vault", 0, 0, 4, 3), R("office", 4, 0, 4, 3), R("bath", 8, 0, 3, 3), R("teller", 0, 3, 11, 2), R("lobby", 0, 5, 11, 3)],
      links: [L(3, 0, "metal"), L(3, 1), L(3, 2), L(3, 4, "open")], entries: [{ r: 4, side: "s", at: 5, k: "glass" }] }],
    pave: [[4, 8, 3, 2]], outdoor: [{ k: "lamp_post", x: 1, y: 9 }, { k: "lamp_post", x: 9, y: 9 }] },
  // Public library: book stacks, reading room, children's corner, circulation desk at the entrance, office.
  { key: "library", w: 13, h: 11, tier: 2, roof: "hip", where: { town: 2 },
    blocks: [{ x: 0, y: 0, w: 13, h: 9, stories: 1, roof: "hip", win: "window_glass",
      rooms: [R("stacks", 0, 0, 8, 5), R("office", 8, 0, 3, 3), R("bath", 11, 0, 2, 3), R("stacks", 8, 3, 5, 2), R("kids", 0, 5, 4, 4), R("lobby", 4, 5, 9, 4)],
      links: [L(5, 0, "open"), L(5, 3, "open"), L(3, 1), L(3, 2), L(5, 4, "arch"), L(0, 3, "open")], entries: [{ r: 5, side: "s", at: 4 }] }],
    pave: [[8, 9, 1, 2]], outdoor: [{ k: "bench_park", x: 1, y: 10 }, { k: "bench_park", x: 10, y: 10 }] },
  // Auto repair shop: two service bays with roll-up doors, parts room, customer office, restroom.
  { key: "auto_shop", w: 12, h: 11, tier: 2, roof: "flat", where: { town: 2, plains: 3, forest: 1 },
    blocks: [{ x: 0, y: 0, w: 12, h: 7, stories: 1, roof: "flat", win: "window_glass", door: "door_metal",
      rooms: [R("bay", 0, 0, 8, 7), R("store", 8, 0, 4, 3), R("bath", 8, 3, 2, 2), R("office", 8, 5, 4, 2), R("hall", 10, 3, 2, 2)],
      links: [L(0, 1, "metal"), L(4, 3, "open"), L(4, 2), L(0, 4)],
      entries: [{ r: 0, side: "s", at: 1, span: 2, k: "metal" }, { r: 0, side: "s", at: 5, span: 2, k: "metal" }, { r: 3, side: "s", at: 2, k: "glass" }] }],
    pave: [[0, 7, 12, 4]], outdoor: [{ k: "barrel_decor", x: 11, y: 9 }, { k: "crate_decor", x: 10, y: 9 }] },
  // Dairy barn: centre drive aisle between stalls, tack room, hayloft above; paddock out back.
  { key: "dairy_barn", w: 10, h: 16, tier: 1, roof: "gambrel", where: { plains: 6, forest: 1 },
    blocks: [{ x: 0, y: 0, w: 10, h: 10, stories: 2, roof: "gambrel", door: "door_wood", stairs: [{ x: 8, y: 2, l: 0 }],
      rooms: [R("stalls", 0, 0, 3, 10), R("hall", 3, 0, 4, 10), R("stalls", 7, 4, 3, 6), R("store", 7, 0, 3, 4),
        R("loft", 0, 0, 3, 10, 1), R("loft", 3, 0, 4, 10, 1), R("loft", 7, 0, 3, 10, 1)],
      links: [L(1, 0, "arch", 2), L(1, 0, "arch", 7), L(1, 2, "arch"), L(1, 3), L(6, 5, "arch", 2), L(6, 5, "arch", 7), L(5, 4, "arch", 2), L(5, 4, "arch", 7)],
      entries: [{ r: 1, side: "s", at: 1, span: 2 }, { r: 1, side: "n", at: 1, span: 2 }] }],
    fence: { x: 0, y: 11, w: 10, h: 5, key: "fence_rail", gate: "n" }, pen: true,
    outdoor: [{ k: "feeding_trough", x: 2, y: 13 }, { k: "pet_trough", x: 6, y: 13 }] },
  // Grain silos: two silo bins and a scale-house office on a paved yard.
  { key: "grain_silo", w: 12, h: 9, tier: 2, roof: "flat", where: { plains: 4 },
    blocks: [
      { x: 0, y: 0, w: 4, h: 4, stories: 3, roof: "flat", stairs: [{ x: 1, y: 2, l: 0 }, { x: 2, y: 2, l: 1 }],
        rooms: [R("bins", 0, 0, 4, 4), R("bins", 0, 0, 4, 4, 1), R("bins", 0, 0, 4, 4, 2)], entries: [{ r: 0, side: "s", at: 1 }] },
      { x: 5, y: 0, w: 4, h: 4, stories: 3, roof: "flat", stairs: [{ x: 1, y: 2, l: 0 }, { x: 2, y: 2, l: 1 }],
        rooms: [R("bins", 0, 0, 4, 4), R("bins", 0, 0, 4, 4, 1), R("bins", 0, 0, 4, 4, 2)], entries: [{ r: 0, side: "s", at: 1 }] },
      { x: 9, y: 5, w: 3, h: 4, stories: 1, roof: "shed", rooms: [R("office", 0, 0, 3, 4)], entries: [{ r: 0, side: "w", at: 1 }] },
    ],
    pave: [[0, 4, 9, 4]], outdoor: [{ k: "barrel_storage", x: 10, y: 1, role: "loot" }] },
  // Warehouse: open storage floor with racking, loading doors, a small office and restroom.
  { key: "warehouse", w: 16, h: 13, tier: 2, roof: "flat", where: { plains: 3, coast: 2, town: 1 },
    blocks: [{ x: 0, y: 0, w: 16, h: 10, stories: 1, roof: "flat", win: "window_glass", door: "door_metal", posts: [[4, 4], [8, 4]],
      rooms: [R("floor", 0, 0, 12, 10), R("office", 12, 0, 4, 5), R("bath", 12, 5, 4, 2), R("hall", 12, 7, 4, 3)],
      links: [L(0, 1), L(0, 3, "open"), L(3, 2)],
      entries: [{ r: 0, side: "s", at: 2, span: 3, k: "metal" }, { r: 0, side: "s", at: 7, span: 3, k: "metal" }, { r: 3, side: "s", at: 1 }] }],
    pave: [[0, 10, 16, 3]] },
  // Small factory: production floor with furnaces / benches, raw-materials store, offices + break room above.
  { key: "factory", w: 18, h: 14, tier: 3, roof: "shed", where: { plains: 2, town: 1, coast: 1 },
    blocks: [{ x: 0, y: 0, w: 18, h: 11, stories: 2, roof: "shed", win: "window_glass", door: "door_metal",
      stairs: [{ x: 13, y: 8, l: 0 }], posts: [[4, 4], [8, 4], [4, 7], [8, 7]],
      rooms: [R("plant", 0, 0, 13, 11), R("store", 13, 0, 5, 5), R("bath", 13, 5, 2, 2), R("hall", 15, 5, 3, 6), R("hall", 13, 7, 2, 4),
        R("store", 0, 0, 13, 11, 1), R("office", 13, 0, 5, 4, 1), R("mess", 13, 4, 5, 3, 1), R("hall", 13, 7, 5, 4, 1)],
      links: [L(0, 1, "metal"), L(0, 4, "metal"), L(4, 3, "open"), L(3, 2), L(7, 6), L(8, 7, "open"), L(8, 5, "door")],
      entries: [{ r: 0, side: "s", at: 3, span: 3, k: "metal" }, { r: 3, side: "s", at: 1 }] }],
    pave: [[0, 11, 18, 3]] },
  // Ranger station: front counter / office, radio room, bunk room, kitchenette, a lookout cabin feel.
  { key: "ranger_station", w: 10, h: 9, tier: 1, roof: "gable", where: { forest: 6, mountain: 4 },
    blocks: [{ x: 0, y: 0, w: 10, h: 7, stories: 1, roof: "gable",
      rooms: [R("bunks", 0, 0, 4, 4), R("bath", 4, 0, 2, 2), R("radio", 6, 0, 4, 4), R("hall", 4, 2, 2, 2), R("kitchen", 0, 4, 4, 3), R("office", 4, 4, 6, 3)],
      links: [L(3, 0), L(3, 1), L(3, 2), L(3, 5, "open"), L(5, 4, "open")], entries: [{ r: 5, side: "s", at: 2 }] }],
    pave: [[6, 7, 1, 2]], outdoor: [{ k: "sign", x: 8, y: 8 }, { k: "campfire", x: 1, y: 8 }] },
  // Hunting lodge: great room with fireplace, kitchen, bunk room and bedrooms on the gallery upstairs.
  { key: "hunting_lodge", w: 12, h: 10, tier: 1, roof: "gable", where: { forest: 5, mountain: 3 },
    blocks: [{ x: 0, y: 0, w: 12, h: 8, stories: 2, roof: "gable", stairs: [{ x: 10, y: 5, l: 0 }], posts: [[3, 3], [4, 4]],
      rooms: [R("lodge", 0, 0, 8, 8), R("kitchen", 8, 0, 4, 4), R("hall", 8, 4, 4, 4),
        R("bed", 0, 0, 4, 4, 1), R("bunks", 4, 0, 4, 4, 1), R("bath", 0, 4, 3, 4, 1), R("hall", 3, 4, 9, 4, 1), R("bed", 8, 0, 4, 4, 1)],
      links: [L(0, 2, "open"), L(2, 1, "arch"), L(0, 1), L(6, 3), L(6, 4), L(6, 5), L(6, 7)],
      entries: [{ r: 0, side: "s", at: 3 }, { r: 2, side: "e", at: 2 }] }],
    pave: [[3, 8, 1, 2]], outdoor: [{ k: "log_store", x: 9, y: 9, role: "loot" }, { k: "campfire", x: 6, y: 9 }] },
  // Lighthouse: four-storey stone tower (stair winding up each floor) with the lamp room on top, keeper's cottage.
  { key: "lighthouse", w: 10, h: 7, tier: 2, roof: "flat", where: { coast: 5 },
    blocks: [
      { x: 0, y: 0, w: 3, h: 3, stories: 4, roof: "flat", win: "window_glass",
        stairs: [{ x: 1, y: 1, l: 0 }, { x: 2, y: 1, l: 1 }, { x: 0, y: 1, l: 2 }],
        rooms: [R("hall", 0, 0, 3, 3), R("hall", 0, 0, 3, 3, 1), R("hall", 0, 0, 3, 3, 2), R("lamp", 0, 0, 3, 3, 3)], entries: [{ r: 0, side: "s", at: 1 }] },
      { x: 4, y: 0, w: 6, h: 5, stories: 1, roof: "gable",
        rooms: [R("living", 0, 0, 3, 5), R("kitchen", 3, 0, 3, 3), R("bed", 3, 3, 3, 2)],
        links: [L(0, 1, "open"), L(0, 2)], entries: [{ r: 0, side: "s", at: 1 }] },
    ],
    pave: [[0, 3, 4, 1], [1, 4, 1, 3], [5, 5, 1, 2]] },
  // Military outpost bunker: blast door, guard room, bunk room, armoury, mess; a watchtower and an iron fence line.
  { key: "bunker", w: 14, h: 12, tier: 3, roof: "flat", where: { mountain: 5, plains: 1, coast: 2, forest: 1 },
    blocks: [{ x: 2, y: 2, w: 10, h: 7, stories: 1, roof: "flat", win: "window_bars", door: "door_metal",
      rooms: [R("bunks", 0, 0, 5, 4), R("armory", 5, 0, 2, 4), R("mess", 7, 0, 3, 4), R("hall", 0, 4, 10, 1), R("office", 0, 5, 4, 2), R("lobby", 4, 5, 3, 2), R("radio", 7, 5, 3, 2)],
      links: [L(3, 0, "metal"), L(3, 1, "metal"), L(3, 2), L(3, 4), L(3, 5, "open"), L(3, 6)], entries: [{ r: 5, side: "s", at: 1, k: "metal" }] }],
    fence: { x: 0, y: 0, w: 14, h: 12, key: "fence_iron", gate: "s" },
    outdoor: [{ k: "watchtower", x: 11, y: 9 }, { k: "barrel_storage", x: 1, y: 9, role: "loot" }, { k: "crate_decor", x: 2, y: 10 }] },
  // Radio relay hut: equipment room + bunk / kitchenette, generator shed (the mast is listed in ART_NEEDS.md).
  { key: "radio_hut", w: 9, h: 7, tier: 2, roof: "flat", where: { mountain: 5, forest: 3, plains: 2, coast: 2 },
    blocks: [
      { x: 0, y: 0, w: 6, h: 5, stories: 1, roof: "flat", door: "door_metal",
        rooms: [R("radio", 0, 0, 4, 5), R("studio", 4, 0, 2, 5)], links: [L(0, 1)], entries: [{ r: 0, side: "s", at: 2 }] },
      { x: 7, y: 2, w: 2, h: 3, stories: 1, roof: "shed", door: "door_metal", rooms: [R("store", 0, 0, 2, 3)], entries: [{ r: 0, side: "w", at: 1 }] },
    ],
    pave: [[2, 5, 1, 2]] },
];

export const REALISTIC_KIND_KEYS: readonly string[] = REALISTIC_KINDS.map((k) => k.key);

// ---------------------------------------------------------------------------------------------------------------------
// builder

const SIDES: readonly RSide[] = ["n", "e", "s", "w"];
function edgeOf(side: RSide, i: number, w: number, h: number): { x: number; y: number } {
  if (side === "n") return { x: i + 0.5, y: 0 };
  if (side === "s") return { x: i + 0.5, y: h };
  if (side === "w") return { x: 0, y: i + 0.5 };
  return { x: w, y: i + 0.5 };
}
/** Tile just inside an exterior slot. */
function tileOfSlot(side: RSide, i: number, w: number, h: number): [number, number] {
  return side === "n" ? [i, 0] : side === "s" ? [i, h - 1] : side === "w" ? [0, i] : [w - 1, i];
}

interface Opening { key: string; door?: string; win?: string }

function roofKeyFor(kind: RoofKind, i: number, j: number, w: number, h: number): { key: string; rot: number } {
  const ew = w >= h;
  if (kind === "eaves" && w >= 3 && h >= 3) {
    const n = j === 0, so = j === h - 1, we = i === 0, ea = i === w - 1;
    if (n && we) return { key: "roof_corner", rot: 2 }; if (n && ea) return { key: "roof_corner", rot: 3 };
    if (so && ea) return { key: "roof_corner", rot: 0 }; if (so && we) return { key: "roof_corner", rot: 1 };
    if (n) return { key: "roof_slope", rot: 2 }; if (so) return { key: "roof_slope", rot: 0 };
    if (we) return { key: "roof_slope", rot: 1 }; if (ea) return { key: "roof_slope", rot: 3 };
    return { key: "roof_flat", rot: 0 };
  }
  if (kind === "gable" || kind === "hip") {
    const along = ew ? i : j, len = ew ? w : h;
    if (kind === "hip" && len >= 3 && along === 0) return { key: "roof_hip", rot: ew ? 2 : 3 };
    if (kind === "hip" && len >= 3 && along === len - 1) return { key: "roof_hip", rot: ew ? 0 : 1 };
    return { key: "roof_gable", rot: ew ? 0 : 1 };
  }
  if (kind === "gambrel") return { key: "roof_gambrel", rot: ew ? 0 : 1 };
  if (kind === "shed") return { key: "roof_shed", rot: ew ? 0 : 1 };
  return { key: "roof_flat", rot: 0 };
}

/** The edges (as tile pairs) two rooms share on one floor, in a stable order. */
function sharedEdges(a: Room, b: Room): { x: number; y: number; ta: [number, number]; tb: [number, number] }[] {
  const out: { x: number; y: number; ta: [number, number]; tb: [number, number] }[] = [];
  if (a.l !== b.l) return out;
  // vertical edges
  if (a.x + a.w === b.x || b.x + b.w === a.x) {
    const ex = a.x + a.w === b.x ? b.x : a.x;
    for (let y = Math.max(a.y, b.y); y < Math.min(a.y + a.h, b.y + b.h); y++) {
      const ta: [number, number] = [ex === b.x ? ex - 1 : ex, y], tb: [number, number] = [ex === b.x ? ex : ex - 1, y];
      out.push({ x: ex, y: y + 0.5, ta, tb });
    }
  }
  if (a.y + a.h === b.y || b.y + b.h === a.y) {
    const ey = a.y + a.h === b.y ? b.y : a.y;
    for (let x = Math.max(a.x, b.x); x < Math.min(a.x + a.w, b.x + b.w); x++) {
      const ta: [number, number] = [x, ey === b.y ? ey - 1 : ey], tb: [number, number] = [x, ey === b.y ? ey : ey - 1];
      out.push({ x: x + 0.5, y: ey, ta, tb });
    }
  }
  return out;
}

const k2 = (x: number, y: number): string => `${x},${y}`;

/** Build one kind's site (site-local coordinates, unrotated, front = south). */
export function buildRealistic(def: KindDef): RBuilt {
  const out: RSpec[] = [];
  const rooms: (Room & { block: number })[] = [];
  let maxStories = 1;
  def.blocks.forEach((b, bi) => {
    maxStories = Math.max(maxStories, b.stories);
    const ox = b.x, oy = b.y;
    const push = (s: RSpec): void => { out.push({ ...s, x: s.x + ox, y: s.y + oy }); };
    for (const r of b.rooms) rooms.push({ ...r, x: r.x + ox, y: r.y + oy, block: bi });
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) push({ key: "foundation", x: x + 0.5, y: y + 0.5, level: 0, rot: 0, role: "deck" });
    if (b.canopy) {
      // a fuel-court canopy: solid L corner posts, an open frame (doorway, no door) on every perimeter slot, a flat roof
      push({ key: "wall_corner_outer", x: 0, y: 0, level: 0, rot: 0, role: "wall" });
      push({ key: "wall_corner_outer", x: b.w, y: 0, level: 0, rot: 1, role: "wall" });
      push({ key: "wall_corner_outer", x: b.w, y: b.h, level: 0, rot: 2, role: "wall" });
      push({ key: "wall_corner_outer", x: 0, y: b.h, level: 0, rot: 3, role: "wall" });
      for (const side of SIDES) {
        const n = side === "n" || side === "s" ? b.w : b.h;
        for (let i = 1; i < n - 1; i++) { const p = edgeOf(side, i, b.w, b.h); push({ key: "wall_doorway", x: p.x, y: p.y, level: 0, rot: 0, role: "wall" }); }
      }
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) push({ key: "roof_flat", x: x + 0.5, y: y + 0.5, level: 1, rot: 0, role: "roof" });
      for (const it of b.items ?? []) pushItem(push, it);
      return;
    }
    const stairs = b.stairs ?? [];
    // decks above the ground floor, with the stairwell hole over each flight
    for (let l = 1; l < b.stories; l++) {
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
        const hole = stairs.some((s) => s.l === l - 1 && s.x === x && s.y === y);
        push({ key: hole ? "floor_stairwell" : "floor", x: x + 0.5, y: y + 0.5, level: l, rot: 0, role: "deck" });
      }
    }
    const roomAt = (l: number, x: number, y: number): number => b.rooms.findIndex((r) => r.l === l && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    // links: door slots on shared edges (open = no wall at all along the shared run)
    const linkSlot = new Map<string, Opening>(); const openEdge = new Set<string>(); const walkway: [number, number, number][] = [];
    for (const lk of b.links ?? []) {
      const a = b.rooms[lk.a], c = b.rooms[lk.b]; if (!a || !c) continue;
      const edges = sharedEdges(a, c); if (edges.length === 0) continue;
      if (lk.k === "open") {
        for (const e of edges) openEdge.add(`${a.l}:${k2(e.x, e.y)}`);
        // an open plan still keeps a walkway clear through the middle of the shared run
        const mid = edges[edges.length >> 1]!; walkway.push([a.l, ...mid.ta], [a.l, ...mid.tb]);
        continue;
      }
      const e = edges[Math.min(edges.length - 1, lk.at ?? (edges.length >> 1))]!;
      linkSlot.set(`${a.l}:${k2(e.x, e.y)}`, { key: "wall_doorway", ...(lk.k === "arch" ? {} : { door: lk.k === "metal" ? "door_metal" : "door_wood" }) });
    }
    // exterior entries (ground floor)
    const entrySlot = new Map<string, Opening>();
    for (const en of b.entries ?? []) {
      const r = b.rooms[en.r]; if (!r) continue;
      const along = en.side === "n" || en.side === "s" ? r.x : r.y; const span = en.side === "n" || en.side === "s" ? r.w : r.h;
      const start = along + (en.at ?? (span >> 1));
      for (let k = 0; k < (en.span ?? 1); k++) {
        const door = en.k === "metal" ? "door_metal" : en.k === "glass" ? "door_metal" : (b.door ?? "door_wood");
        entrySlot.set(`${r.l}:${en.side}:${start + k}`, { key: "wall_doorway", door });
      }
    }
    for (let l = 0; l < b.stories; l++) {
      // exterior shell: an L at each corner, then each side's slots
      push({ key: "wall_corner_outer", x: 0, y: 0, level: l, rot: 0, role: "wall" });
      push({ key: "wall_corner_outer", x: b.w, y: 0, level: l, rot: 1, role: "wall" });
      push({ key: "wall_corner_outer", x: b.w, y: b.h, level: l, rot: 2, role: "wall" });
      push({ key: "wall_corner_outer", x: 0, y: b.h, level: l, rot: 3, role: "wall" });
      for (const side of SIDES) {
        const n = side === "n" || side === "s" ? b.w : b.h;
        for (let i = 1; i < n - 1; i++) {
          const p = edgeOf(side, i, b.w, b.h);
          const ent = entrySlot.get(`${l}:${side}:${i}`);
          if (ent) { push({ key: ent.key, x: p.x, y: p.y, level: l, rot: 0, role: "wall" }); push({ key: ent.door!, x: p.x, y: p.y, level: l, rot: 0, role: "opening" }); continue; }
          const [tx, ty] = tileOfSlot(side, i, b.w, b.h);
          const ri = roomAt(l, tx, ty); const room = b.rooms[ri];
          if (room && wantsWindow(room, side, i, b, l)) {
            push({ key: "wall_window", x: p.x, y: p.y, level: l, rot: 0, role: "wall" });
            push({ key: b.win ?? "window_shutters", x: p.x, y: p.y, level: l, rot: 0, role: "opening" });
          } else push({ key: "wall", x: p.x, y: p.y, level: l, rot: 0, role: "wall" });
        }
      }
      // partitions between rooms
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
        const here = roomAt(l, x, y);
        for (const [nx, ny, ex, ey] of [[x + 1, y, x + 1, y + 0.5], [x, y + 1, x + 0.5, y + 1]] as const) {
          if (nx >= b.w || ny >= b.h) continue;
          const there = roomAt(l, nx, ny); if (there === here) continue;
          const key = `${l}:${k2(ex, ey)}`;
          if (openEdge.has(key)) continue;
          const slot = linkSlot.get(key);
          if (slot) { push({ key: slot.key, x: ex, y: ey, level: l, rot: 0, role: "wall" }); if (slot.door) push({ key: slot.door, x: ex, y: ey, level: l, rot: 0, role: "opening" }); }
          else push({ key: "wall", x: ex, y: ey, level: l, rot: 0, role: "wall" });
        }
      }
    }
    for (const s of stairs) push({ key: "stairs", x: s.x + 0.5, y: s.y + 0.5, level: s.l, rot: 0, role: "stair" });
    for (const [px, py] of b.posts ?? []) for (let l = 0; l < b.stories; l++) push({ key: "pillar", x: px + 0.5, y: py + 0.5, level: l, rot: 0, role: "wall" });
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
      const rk = roofKeyFor(b.roof, x, y, b.w, b.h);
      push({ key: rk.key, x: x + 0.5, y: y + 0.5, level: b.stories, rot: rk.rot, role: "roof" });
    }
    // furnishings
    const keep = keepTiles(b, linkSlot, entrySlot);
    for (const [l, x, y] of walkway) keep.add(`${l}:${k2(x, y)}`);
    const taken = new Set<string>();
    for (const [px, py] of b.posts ?? []) for (let l = 0; l < b.stories; l++) taken.add(`${l}:${k2(px, py)}`);
    for (const it of b.items ?? []) { pushItem(push, it); for (const t of footTiles(it.k, it.x, it.y, it.r ?? 0)) taken.add(`${it.l ?? 0}:${k2(t[0], t[1])}`); }
    b.rooms.forEach((r) => furnish(r, b, keep, taken, push));
  });
  // site-level: paving, fences, outdoor pieces
  for (const [px, py, pw, ph] of def.pave ?? []) for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) out.push({ key: "path_stone", x: x + 0.5, y: y + 0.5, level: 0, rot: 0, role: "furniture" });
  if (def.fence) fenceRing(out, def.fence);
  for (const it of def.outdoor ?? []) pushItem((s) => out.push(s), it);
  return { w: def.w, h: def.h, stories: maxStories, garden: !!def.garden, pen: !!def.pen, pieces: out, rooms, roof: def.roof, tier: def.tier };
}

function footTiles(key: string, x: number, y: number, rot: number): [number, number][] {
  const f = FACTS.get(key) ?? { w: 1, h: 1 };
  const w = rot & 1 ? f.h : f.w, h = rot & 1 ? f.w : f.h;
  const out: [number, number][] = []; for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([x + i, y + j]); return out;
}
/** An item at tile anchor (x, y) as a spec at its footprint centre. */
function pushItem(push: (s: RSpec) => void, it: Item): void {
  const f = FACTS.get(it.k) ?? { w: 1, h: 1 }; const r = it.r ?? 0;
  const w = r & 1 ? f.h : f.w, h = r & 1 ? f.w : f.h;
  push({ key: it.k, x: it.x + w / 2, y: it.y + h / 2, level: it.l ?? 0, rot: r, role: it.role ?? roleOf(it.k) });
}

function fenceRing(out: RSpec[], f: NonNullable<KindDef["fence"]>): void {
  for (let x = 0; x < f.w; x++) {
    const gn = f.gate === "n" && x === (f.w >> 1), gs = f.gate === "s" && x === (f.w >> 1);
    out.push({ key: gn ? "garden_gate" : f.key, x: f.x + x + 0.5, y: f.y + 0.15, level: 0, rot: 0, role: "fence" });
    out.push({ key: gs ? "garden_gate" : f.key, x: f.x + x + 0.5, y: f.y + f.h - 0.15, level: 0, rot: 0, role: "fence" });
  }
  for (let y = 1; y < f.h - 1; y++) {
    const gw = f.gate === "w" && y === (f.h >> 1), ge = f.gate === "e" && y === (f.h >> 1);
    out.push({ key: gw ? "garden_gate" : f.key, x: f.x + 0.15, y: f.y + y + 0.5, level: 0, rot: 1, role: "fence" });
    out.push({ key: ge ? "garden_gate" : f.key, x: f.x + f.w - 0.15, y: f.y + y + 0.5, level: 0, rot: 1, role: "fence" });
  }
}

/** Window rule for one exterior slot of a room. */
function wantsWindow(room: Room, side: RSide, i: number, b: Block, l: number): boolean {
  const rule = WINDOWS[room.t]; if (rule === "none") return false;
  const n = side === "n" || side === "s" ? b.w : b.h;
  if (i <= 0 || i >= n - 1) return false;
  const start = side === "n" || side === "s" ? room.x : room.y, len = side === "n" || side === "s" ? room.w : room.h;
  const p = i - start;
  if (rule === "all") return true;
  if (rule === "store") return side === "s" ? true : len >= 3 && p % 3 === 1;
  if (rule === "one") {
    // the room's first exterior side in n, e, s, w order, centre slot
    for (const sd of SIDES) {
      const touches = sd === "n" ? room.y === 0 : sd === "s" ? room.y + room.h === b.h : sd === "w" ? room.x === 0 : room.x + room.w === b.w;
      if (!touches) continue;
      const st = sd === "n" || sd === "s" ? room.x : room.y, ln = sd === "n" || sd === "s" ? room.w : room.h;
      const nn = sd === "n" || sd === "s" ? b.w : b.h;
      let c = st + (ln >> 1); if (c <= 0) c = 1; if (c >= nn - 1) c = nn - 2;
      return sd === side && c === i;
    }
    return false;
  }
  // spaced: one window per 3 m of wall, centred in short runs
  if (len <= 2) return p === (len >> 1) || (start + (len >> 1) <= 0 && p === len - 1) || (start + (len >> 1) >= n - 1 && p === 0);
  void l;
  return p % 3 === 1;
}

/** Tiles furniture must leave clear, per floor: both sides of every doorway, stair entry / flight / landing / hole. */
function keepTiles(b: Block, linkSlot: Map<string, Opening>, entrySlot: Map<string, Opening>): Set<string> {
  const keep = new Set<string>();
  const add = (l: number, x: number, y: number): void => { keep.add(`${l}:${k2(x, y)}`); };
  for (const key of linkSlot.keys()) {
    const [ls, xs, ys] = key.split(/[:,]/) as [string, string, string]; const l = +ls, x = +xs, y = +ys;
    if (Number.isInteger(x)) { add(l, x - 1, Math.floor(y)); add(l, x, Math.floor(y)); } else { add(l, Math.floor(x), y - 1); add(l, Math.floor(x), y); }
  }
  for (const key of entrySlot.keys()) {
    const [ls, side, is] = key.split(":") as [string, RSide, string];
    const [tx, ty] = tileOfSlot(side, +is, b.w, b.h); add(+ls, tx, ty);
    const [ix, iy] = side === "n" ? [tx, ty + 1] : side === "s" ? [tx, ty - 1] : side === "w" ? [tx + 1, ty] : [tx - 1, ty];
    if (ix >= 0 && iy >= 0 && ix < b.w && iy < b.h) add(+ls, ix, iy);
  }
  for (const s of b.stairs ?? []) { add(s.l, s.x, s.y); add(s.l, s.x, s.y + 1); add(s.l + 1, s.x, s.y); add(s.l + 1, s.x, s.y - 1); }
  return keep;
}

/** Seat a room's programme. Deterministic; every keep tile stays clear and all of them stay mutually reachable. */
function furnish(r: Room, b: Block, keep: Set<string>, taken: Set<string>, push: (s: RSpec) => void): void {
  const prog = PROGRAMME[r.t]; if (!prog) return;
  const area = r.w * r.h; const cap = Math.floor(area * (prog.fill ?? 0.45));
  let used = 0;
  const inRoom = (x: number, y: number): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  const tkey = (x: number, y: number): string => `${r.l}:${k2(x, y)}`;
  const free = (x: number, y: number): boolean => inRoom(x, y) && !taken.has(tkey(x, y)) && !keep.has(tkey(x, y));
  const keeps: [number, number][] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (keep.has(tkey(x, y))) keeps.push([x, y]);
  const connected = (extra: [number, number][]): boolean => {
    if (keeps.length === 0) return true;
    const block = new Set(extra.map(([x, y]) => k2(x, y)));
    const open = (x: number, y: number): boolean => inRoom(x, y) && !block.has(k2(x, y)) && !taken.has(tkey(x, y));
    const seen = new Set<string>([k2(keeps[0]![0], keeps[0]![1])]); const q: [number, number][] = [keeps[0]!];
    while (q.length) {
      const [x, y] = q.pop()!;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        const kk = k2(nx, ny); if (seen.has(kk) || !open(nx, ny)) continue; seen.add(kk); q.push([nx, ny]);
      }
    }
    if (!keeps.every(([x, y]) => seen.has(k2(x, y)))) return false;
    // and most of the room's open floor stays one walkable piece (no sealed-off pockets behind furniture)
    let openCount = 0; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (open(x, y)) openCount++;
    return seen.size >= openCount;
  };
  const tryPut = (key: string, x: number, y: number, rot: number): boolean => {
    if (used >= cap) return false;
    const tiles = footTiles(key, x, y, rot);
    if (!tiles.every(([tx, ty]) => free(tx, ty))) return false;
    if (!connected(tiles)) return false;
    for (const [tx, ty] of tiles) taken.add(tkey(tx, ty));
    used += tiles.length;
    pushItem(push, { k: key, x, y, l: r.l, r: rot });
    return true;
  };
  // perimeter tiles clockwise from the north-west corner, each with the rotation that puts the piece's back to the wall
  const perim: [number, number, number][] = [];
  for (let x = r.x; x < r.x + r.w; x++) perim.push([x, r.y, 2]);
  for (let y = r.y + 1; y < r.y + r.h; y++) perim.push([r.x + r.w - 1, y, 3]);
  if (r.h > 1) for (let x = r.x + r.w - 2; x >= r.x; x--) perim.push([x, r.y + r.h - 1, 0]);
  if (r.w > 1) for (let y = r.y + r.h - 2; y > r.y; y--) perim.push([r.x, y, 1]);
  const placeWall = (key: string): boolean => {
    for (const [x, y, face] of perim) {
      const f = FACTS.get(key) ?? { w: 1, h: 1 };
      // a long piece runs along its wall: north / south walls keep it east-west, east / west walls turn it
      const along = face === 1 || face === 3 ? 1 : 0;
      const rots = f.w === f.h ? [face] : [along === 0 ? (f.w >= f.h ? face & 2 : (face & 2) + 1) : (f.w >= f.h ? 1 + (face & 2) : face & 2)];
      for (const rot of rots) {
        const fw = rot & 1 ? f.h : f.w, fh = rot & 1 ? f.w : f.h;
        // anchor so the footprint hugs the wall it backs onto
        const ax = face === 3 ? x - fw + 1 : x, ay = face === 0 ? y - fh + 1 : y;
        if (tryPut(key, ax, ay, rot)) return true;
      }
    }
    return false;
  };
  const interior: [number, number][] = [];
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) interior.push([x, y]);
  const placeMid = (key: string): boolean => {
    const spots = interior.length ? interior : perim.map(([x, y]) => [x, y] as [number, number]);
    for (const [x, y] of spots) for (const rot of [0, 1]) if (tryPut(key, x, y, rot)) return true;
    return false;
  };
  if (prog.aisle) {
    // shelving: every other column inside the walls, leaving the perimeter aisle and a cross aisle in long rooms
    for (let x = r.x + 1; x < r.x + r.w - 1; x += 2) for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
      if (r.h >= 7 && y === r.y + (r.h >> 1)) continue;
      tryPut(prog.aisle, x, y, 0);
    }
  }
  if (prog.rows) {
    const f = FACTS.get(prog.rows) ?? { w: 1, h: 1 }; const cx = r.x + (r.w >> 1);
    for (let y = r.y + 1; y < r.y + r.h - 1; y += 2) for (let x = r.x + 1; x + f.w - 1 < r.x + r.w - 1; x += f.w) {
      if (x <= cx && x + f.w - 1 >= cx) continue; // the centre aisle
      tryPut(prog.rows, x, y, 0);
    }
  }
  for (const key of prog.wall ?? []) placeWall(key);
  for (const key of prog.mid ?? []) placeMid(key);
}

const cache = new Map<string, RBuilt>();
/** The built (unrotated) site for a realistic kind key — built once, shared (callers must copy before mutating). */
export function realisticBuilt(key: string): RBuilt {
  let b = cache.get(key);
  if (!b) { const def = REALISTIC_KINDS.find((k) => k.key === key); if (!def) throw new Error(`unknown realistic kind ${key}`); b = buildRealistic(def); cache.set(key, b); }
  return b;
}
