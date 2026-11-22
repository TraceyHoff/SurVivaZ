/**
 * Render-side ECS components (numeric fields only, core schema format).
 * Register them on the World (client AND server if they are ever networked; currently local-only).
 */
import { defineComponent } from "@engine/core";

/**
 * Billboard sprite drawn at the entity's (interpolated) Transform foot point.
 * `spriteId` is the stable numeric id from the @engine/assets registry (key -> id at load time).
 * With an AnimState component the frame comes from state/facing/time; otherwise `frameId` selects
 * a frame (variant) of the sprite's first animation.
 */
export const Sprite = defineComponent("Sprite", {
  spriteId: "u16",
  frameId: "u16",
  flags: "u8", // SpriteFlag bits
  scale: "f32", // uniform scale, 0 is treated as 1
  tint: "u32", // RGBA8 packed multiply tint (0 = none), e.g. from an asset tint set / variant
});

/** Point light (flickering campfire/torch etc.). Colour is linear 0..1, radius in tiles. */
export const LightSource = defineComponent("LightSource", {
  r: "f32", g: "f32", b: "f32",
  radius: "f32",
  intensity: "f32",
  flicker: "f32", // 0 = steady, ~0.3 = torch, ~0.5 = campfire
});

/** Sun-cast projected sprite shadow. Entities without it cast no shadow. */
export const Shadow = defineComponent("Shadow", {
  alpha: "f32", // opacity multiplier (0..1)
  length: "f32", // length multiplier, 1 = default
});

/**
 * Iso occluder: when this sprite covers the renderer's focus entity (the local player) and is in
 * front of it, it fades to `fade` alpha so the player stays visible behind trees/walls.
 */
export const Occluder = defineComponent("Occluder", {
  fade: "f32", // alpha while occluding (e.g. 0.35)
});

/**
 * Secondary tint for two-tone tint masks (atlas `masks.tintmask`: R = Sprite.tint / BuildPiece.tint, G = this colour),
 * e.g. clan colour pairs. RGBA8 packed like Sprite.tint; 0 = reuse the primary tint.
 */
export const TintSecondary = defineComponent("TintSecondary", {
  tint: "u32",
});

/**
 * Piece of a vehicle interior (camper) drawn by the interior pass (SpriteBatch.drawInterior) instead of the depth-sorted
 * sprite pass: floor (role 1) at ground level with no depth test (never clipped by terrain), then far walls, the
 * occupants (dynamic sprites standing inside a floor's footprint), then near walls faded/cut. The footprint (centre,
 * heading, length, width in tiles) is carried by the floor pieces; it decides who is an occupant and which walls are near.
 */
export const InteriorPart = defineComponent("InteriorPart", {
  role: "u8", // InteriorRole
  cx: "f32", cy: "f32", heading: "f32", length: "f32", width: "f32",
});
export const InteriorRole = { Floor: 1, Wall: 2 } as const;

/**
 * ADR-238: whole-sprite opacity multiplier (0..1) for a gentle fade of the item itself (ground loot about to despawn).
 * Multiplies the sprite's alpha and its projected shadow; entities without it draw at full opacity.
 */
export const SpriteAlpha = defineComponent("SpriteAlpha", {
  alpha: "f32",
});

/**
 * ADR-519: Art's paint contract for Sprite.tint through the atlas tintmask R only: out = base * mix(1, tint / neutral,
 * strength * mask.r) (vehicles: neutral 0.78, so a neutral-grey body pixel becomes exactly the paint colour). Without a
 * resident mask the sprite draws unpainted (never a whole-frame tint over glass and tyres).
 */
export const TintNeutral = defineComponent("TintNeutral", {
  neutral: "f32", strength: "f32",
});

export const RENDER_COMPONENTS = [Sprite, LightSource, Shadow, Occluder, TintSecondary, InteriorPart, SpriteAlpha, TintNeutral] as const;

export { SpriteFlag, TileId } from "./ids.js";
