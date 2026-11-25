/** ADR-276: top-surface relief, not a HUD marker. View-ordered +u,+v,-u,-v drop depths.
 * Only inspect the four resident neighbours when a chunk is rebuilt; void/stream boundaries are not pits.
 * Water's 0.25-level surface inset must not create a false ledge. */
import { NO_TILE_HEIGHT } from "./tilemap.js";

export function terrainDropEdges(z: number, u: number, v: number, nu: number, nv: number): [number, number, number, number] {
  const depth = (h: number): number => h <= NO_TILE_HEIGHT || z - h < 1 ? 0 : Math.min(8, z - h);
  return [depth(u), depth(v), depth(nu), depth(nv)];
}

/** Texture-preserving dark cut + thin sunlit inner bevel. Rear (-u/-v) edges get a broader, stronger cut:
 * their vertical face can be completely hidden by the high tile itself. This stays ON the high surface,
 * so it cannot disappear behind that tile like the existing far-side cliff geometry.
 * Shared by every textured ground material / season, including the legacy art while pages stream. */
export const DROP_EDGE_GLSL = /* glsl */ `
vec3 terrainDropRelief(vec3 color, vec2 cell, vec4 drops) {
  vec4 dist = vec4(1.0 - cell.x, 1.0 - cell.y, cell.x, cell.y);
  vec4 depth = clamp(drops / 6.0, 0.0, 1.0);
  vec4 present = step(vec4(0.5), drops);
  vec4 width = mix(vec4(0.045, 0.045, 0.085, 0.085), vec4(0.075, 0.075, 0.16, 0.16), depth);
  vec4 cut = (1.0 - smoothstep(width * 0.25, width, dist)) * present;
  vec4 strength = mix(vec4(0.22, 0.22, 0.38, 0.38), vec4(0.34, 0.34, 0.60, 0.60), depth);
  vec4 bevel = smoothstep(width * 0.75, width, dist) * (1.0 - smoothstep(width, width + 0.045, dist)) * present;
  float shade = max(max(cut.x * strength.x, cut.y * strength.y), max(cut.z * strength.z, cut.w * strength.w));
  float light = max(max(bevel.x, bevel.y), max(bevel.z, bevel.w));
  return color * (1.0 - shade) + vec3(0.085, 0.070, 0.045) * light;
}
`;
