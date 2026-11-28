/**
 * Light table for the client view: every light-emitting thing maps to a renderer light (radius tiles, colour, flicker).
 * Primary source: Art's survival_fx/render_tuning.json `heatSources.light` (keyed by piece/sprite key, wildcards `*`);
 * client defaults fill gaps (furnace, stations without a piece key, emissive props, held torches).
 */
export interface LightSpec { radius: number; intensity: number; r: number; g: number; b: number; flicker: number }

const hex = (c: string): [number, number, number] => { const n = parseInt(c.replace("#", ""), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const mk = (radius: number, intensity: number, color: string, flicker: number): LightSpec => { const [r, g, b] = hex(color); return { radius, intensity, r, g, b, flicker }; };

/** Fallbacks (used when render_tuning lacks the key). ADR-216: radii are the distance at which the light has faded to
 *  zero (smooth plateau profile, full strength to ~35% and still clearly lit at ~75%). Light PIECES are drawn with the
 *  replicated gameplay Emitter radius (pieces.json lightRadius) so the lit area and zombie light-avoidance match; the
 *  radius here is used only for things without a gameplay light (free-standing bonfire, props, held lights). */
export const DEFAULT_LIGHTS: Record<string, LightSpec> = {
  campfire: mk(8, 1.3, "#ff9a4a", 0.55), bonfire: mk(8, 1.4, "#ff8f40", 0.6),
  torch_stand: mk(6, 1.05, "#ffa54f", 0.7), torch: mk(6, 1.05, "#ffa54f", 0.7),
  held_torch: mk(5.5, 1.0, "#ffa54f", 0.7), held_lantern: mk(5, 0.95, "#ffb868", 0.2), held_tallow_candle: mk(3, 0.8, "#ffc27a", 0.35),
  held_candle: mk(3, 0.8, "#ffc27a", 0.35),
  lantern: mk(6, 0.95, "#ffb060", 0.25), lantern_hanging: mk(6, 0.95, "#ffb060", 0.25),
  candle: mk(3, 0.8, "#ffc27a", 0.35), candelabra: mk(4, 0.9, "#ffc27a", 0.3),
  table_lamp: mk(4.5, 0.9, "#ffd08a", 0.08), floor_lamp: mk(6, 0.95, "#ffd08a", 0.08), wall_sconce: mk(5, 0.9, "#ffb868", 0.2),
  chandelier: mk(7, 1.0, "#ffc887", 0.15), lamp_post: mk(9, 1.0, "#ffd9a0", 0.06),
  fireplace: mk(8, 1.2, "#ff8f40", 0.45), wood_stove: mk(6, 0.95, "#ff8238", 0.35), stove_iron: mk(5, 0.9, "#ff8238", 0.3),
  cook_range: mk(5, 0.9, "#ff8238", 0.3), clay_oven: mk(4.5, 0.9, "#ff7a30", 0.35),
  furnace: mk(6, 1.1, "#ff7a30", 0.4), heat_brazier: mk(6.5, 1.2, "#ff9a4a", 0.5),
  glow_mushrooms: mk(2.5, 0.55, "#7ff0d8", 0.1), "prop_glow_mushroom_*": mk(2.5, 0.55, "#7ff0d8", 0.1),
  mirror: mk(1.5, 0.4, "#cfe8ff", 0.05),
  // ADR-590 electricity tier: steady (no flicker) warm-white LEDs; on only while powered (Emitter strength follows Power.active)
  electric_floor_lamp: mk(7, 1.0, "#fff1d6", 0), electric_table_lamp: mk(5, 0.9, "#fff1d6", 0), electric_wall_light: mk(6, 0.95, "#fff1d6", 0),
  ceiling_light: mk(8, 1.0, "#fff6e8", 0), flood_light: mk(12, 1.15, "#f4f8ff", 0),
  // ADR-593: powered building tier (walls / floors / foundations / pillars glow while powered)
  powered_tier: mk(6, 0.85, "#fff1d6", 0),
};
/** Item keys whose held light is looked up as `held_<key>` (main hand or off hand). Visual only (ADR-216). */
export const HELD_LIGHT_ITEMS: readonly string[] = ["torch", "lantern", "tallow_candle", "candle"];

export class LightTable {
  private t: Record<string, LightSpec> = { ...DEFAULT_LIGHTS };
  /** Merge render_tuning.json heatSources.light (base entry; byAnim variants are visual sizes, not used here). */
  load(tuning: unknown): number {
    const l = (tuning as { heatSources?: { light?: Record<string, { radiusTiles?: number; intensity?: number; color?: string; flicker?: number }> } })?.heatSources?.light;
    if (!l) return 0; let n = 0;
    for (const [k, v] of Object.entries(l)) {
      if (!v || typeof v.radiusTiles !== "number") continue;
      const d = this.t[k]; this.t[k] = mk(v.radiusTiles, v.intensity ?? d?.intensity ?? 1, v.color ?? "#ffa54f", v.flicker ?? d?.flicker ?? 0.3); n++;
    }
    return n;
  }
  get(key: string | undefined): LightSpec | undefined {
    if (!key) return undefined; const hit = this.t[key]; if (hit) return hit;
    for (const [k, v] of Object.entries(this.t)) if (k.includes("*") && new RegExp(`^${k.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(key)) return v;
    return undefined;
  }
  /** Light carried by a character holding `itemKey` (held torch/lantern/candle), or undefined. */
  held(itemKey: string | undefined): LightSpec | undefined { return itemKey && HELD_LIGHT_ITEMS.includes(itemKey) ? this.get(`held_${itemKey}`) : undefined; }
  /** Spec for a light piece drawn at its gameplay Emitter radius (ADR-216: visuals == light-avoidance radius). */
  static withRadius(spec: LightSpec, radius: number | undefined): LightSpec { return radius && radius > 0 && radius !== spec.radius ? { ...spec, radius } : spec; }
}
