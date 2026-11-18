/** ADR-264: display authoritative shovel failures on every input device. */
import type { CommandDef } from "@engine/core";
import { TerrainCmd, TerrainRampCmd, TERRAIN_FAIL_REASONS, TERRAIN_FAIL_TEXT } from "@engine/gameplay";
export function terrainRejectText(cmd: CommandDef | undefined, reason: string): string | undefined {
  if (cmd !== TerrainCmd && cmd !== TerrainRampCmd) return undefined; // ADR-419: a rejected ramp reports like a rejected dig
  const code = (TERRAIN_FAIL_REASONS as readonly string[]).indexOf(reason);
  return TERRAIN_FAIL_TEXT[code] ?? "Can't edit ground here";
}
