/** Shared simulation/HUD exposure stages. Status keys are dedicated UI-atlas frames, not diseases. */
export type TemperatureTier = "chilly" | "cold" | "freezing" | "hot" | "sweltering" | "overheating";
/** Body temperature in Celsius: warnings precede the sole damaging tier on each side. */
export function temperatureTier(body: number): TemperatureTier | undefined {
  if (body <= 35) return "freezing";
  if (body <= 36) return "cold";
  if (body <= 36.5) return "chilly";
  if (body >= 39) return "overheating";
  if (body >= 38) return "sweltering";
  if (body >= 37.5) return "hot";
  return undefined;
}
export function damagingTemperatureTier(tier: TemperatureTier | undefined): boolean {
  return tier === "freezing" || tier === "overheating";
}
export type WetnessStage = "damp" | "wet" | "soaked";
export function wetnessStage(wet: number): WetnessStage | undefined {
  return wet > 0.7 + 1e-6 ? "soaked" : wet > 0.3 + 1e-6 ? "wet" : wet > 0 ? "damp" : undefined;
}
/** Wetness only accelerates illness timing; it never directly drains HP. Dry is the baseline. */
export function wetIllnessTimeMul(wet: number): number {
  const stage = wetnessStage(wet);
  return stage === "soaked" ? 0.85 : stage === "wet" ? 0.9 : stage === "damp" ? 0.95 : 1;
}
/** Upper bound and drying-rate multiplier of each band (low to high). Continuous wetting is unchanged. */
const DRY_BANDS = [{ top: 0.3, mul: 1 }, { top: 0.7, mul: 0.5 }, { top: 1, mul: 0.25 }] as const;
/** Exact integration across stage boundaries, independent of simulation tick size. */
export function dryWetness(wet: number, seconds: number, baseRate: number): number {
  let remaining = Math.max(0, seconds), value = Math.min(1, Math.max(0, wet));
  for (let i = DRY_BANDS.length - 1; i >= 0; i--) {
    const bottom = i === 0 ? 0 : DRY_BANDS[i - 1]!.top;
    if (value <= bottom) continue;
    const rate = baseRate * DRY_BANDS[i]!.mul;
    if (rate <= 0) return value;
    const used = Math.min(remaining, (value - bottom) / rate);
    value = Math.max(bottom, value - used * rate); remaining -= used;
  }
  return value < 1e-8 ? 0 : value;
}
/** Time to fully dry, including the progressively faster lower stages. Fire multiplies baseRate. */
export function wetDrySeconds(wet: number, baseRate: number): number {
  let seconds = 0, bottom = 0;
  for (const band of DRY_BANDS) {
    seconds += Math.max(0, Math.min(1, wet, band.top) - bottom) / (baseRate * band.mul);
    bottom = band.top;
  }
  return seconds;
}
