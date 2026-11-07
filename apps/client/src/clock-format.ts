/**
 * ADR-284: the one player-facing clock format - 12-hour AM/PM over the full 24-hour world day. Midnight is 12:00 AM,
 * noon 12:00 PM (never 0:00 or 24:00). The input is wall-clock world hours (the HUD's server-tick day clock); seasonal
 * sunrise / sunset (ADR-283) move around it, the clock itself never stretches.
 */
export function formatClock12(hours: number): string {
  const totalMin = Math.floor((((hours % 24) + 24) % 24) * 60 + 1e-6) % 1440;
  const h24 = Math.floor(totalMin / 60), mm = totalMin % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}
