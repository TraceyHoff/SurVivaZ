/**
 * Survival HUD in Art's "cozy-camp" UI theme (assets/ui/theme.json palette + Fredoka, served at `<base>art/ui/`):
 * health / hunger / thirst / stamina bars, ADR-239 temperature gauge, clock, season and weather. Plain DOM, hooks: `#hud`, `[data-stat=...]`.
 * Compact and anchored top-left inside the safe area (`--sat/--sal` from ./ui-root.ts), click-through (pointer-events:none)
 * so it never eats taps meant for the touch controls, which live in the lower half / right edge.
 */
import { uiSprites } from "./ui-atlas.js";
import { mountUi } from "./ui-root.js";
import { Weather, Transform, type Entity, type World } from "@engine/core";
import { dayCount, dayHours, sunScheduleNow } from "./day-clock.js";
import { formatClock12 } from "./clock-format.js";
import { sunFractionFor } from "@engine/core";
import { activeDiseases, diseasePresentation, infectionTier, Diseases, Exposure, Health, RoomHeat, Survival, temperatureTier, damagingTemperatureTier, wetnessStage } from "@engine/gameplay";
import { conditionIconImg, iconImg, iconUrl } from "./game-icons.js";
import { seasonAtDays } from "@engine/core";
import { formatBodyTemp, formatTemp, gaugeFrac, TEMP_UNIT_EVENT, GAUGE_GRADIENT, hudAirTemp, hudShelteredTemp, loadTempUnit, SEASON_LABEL, tempBand, type TempUnit } from "./hud-temp.js";

export const WEATHER_LABEL = ["Clear", "Rain", "Storm", "Snow", "Fog", "Overcast", "Heat", "Blizzard", "Windy"];
const STATS = [
  { key: "hp", color: "#E8475F", icon: "ic_health.png" }, { key: "hunger", color: "#F4A74A", icon: "ic_hunger.png" },
  { key: "thirst", color: "#5CC6DC", icon: "ic_thirst.png" }, { key: "stamina", color: "#FFD45A", icon: "ic_stamina.png" },
] as const;
/** Task 25: custom pixel-art icons (embedded data URIs, game-icons-data.ts — never a public/icons/ fetch) for the season glyph. */
const SEASON_ICON = ["ic_sun.png", "ic_leaf.png", "ic_snowflake.png", "ic_blossom.png"] as const; // SeasonId order: summer, fall, winter, spring (Art: dedicated spring blossom)

/**
 * ADR-312: HUD shelter state from the replicated Exposure.sheltered percent (0..100). Hidden below 10%; 100% is
 * "Indoors" (fully enclosed and roofed); otherwise "Sheltered N%" rounded to 5% so the chip does not flicker.
 */
export function shelterChipState(pct: number): { show: boolean; full: boolean; pct: number; label: string } {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  if (p < 10) return { show: false, full: false, pct: p, label: "" };
  if (p >= 100) return { show: true, full: true, pct: 100, label: "Indoors" };
  const r = Math.min(95, Math.max(10, Math.round(p / 5) * 5));
  return { show: true, full: false, pct: r, label: `Sheltered ${r}%` };
}
export interface HudOverrides { hours?: number; weather?: number; /** ADR-239 ?season= (0 summer, 1 fall, 2 winter) */ season?: number; /** tests: unit instead of Settings */ unit?: TempUnit }
const SPRITE_KEYS = ["health", "hunger", "thirst", "stamina"] as const;

/** Days to evaluate the temperature at when ?season= / ?time= override the view (middle of the overridden season). */
export function overrideDays(w: World, days: number, ov: HudOverrides): number {
  const L = seasonAtDays(w, 0).lengthDays; const day = Math.floor(days), t = ov.hours !== undefined ? ov.hours / 24 : days - day;
  if (ov.season === undefined || !(L > 0)) return day + t;
  const s = seasonAtDays(w, day); const base = day - Math.floor(s.into); // start of the current season (whole days)
  const target = Math.floor(((ov.season % 4) + 4) % 4);
  return base + (((target - s.index) % 3) + 3) % 3 * L + Math.floor(L / 2) + t;
}
export function mountHud(world: () => World, player: () => Entity | undefined, ov: HudOverrides = {}, onCharacter?: () => void): { destroy(): void } {
  const base = import.meta.env.BASE_URL;
  const style = document.createElement("style");
  style.textContent = `@font-face{font-family:Fredoka;src:url(${base}art/ui/fonts/Fredoka.ttf) format("truetype");font-display:swap}
#hud{position:absolute;left:calc(6px + var(--sal,0px));top:calc(6px + var(--sat,0px));z-index:5;font:600 11px/1.1 Fredoka,system-ui,sans-serif;color:#3B2433;background:rgba(246,234,210,.88);
border:2px solid #74432C;border-radius:10px;box-shadow:0 2px 0 #432C24;padding:4px 6px;width:clamp(112px,18vw,150px);box-sizing:border-box;user-select:none;pointer-events:auto;cursor:pointer}
#hud:focus-visible{outline:3px solid #FFD45A;outline-offset:3px}
#hud .row{display:flex;align-items:center;gap:4px;margin:2px 0}#hud .bar{flex:1;height:6px;background:#E6C47E;border:1px solid #4A2F3D;border-radius:4px;overflow:hidden}
#hud .lab{display:flex;width:14px;font-size:10px;justify-content:center}
#hud .fill{height:100%;border-radius:3px;transition:width .2s}#hud .clock{display:flex;justify-content:space-between;margin-bottom:2px;color:#61402E;font-size:10px}
#hud .clock .l{min-width:0;white-space:nowrap}#hud [data-hud=weather]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:3px}
#hud [data-hud=season]{margin-left:2px;font-size:10px}
#hud .row[data-stat=temp] .bar{position:relative;overflow:visible}#hud .row[data-stat=temp] .grad{position:absolute;inset:0;border-radius:3px;background:${GAUGE_GRADIENT}}
#hud .row[data-stat=temp] .air{position:absolute;top:-2px;bottom:-2px;width:3px;margin-left:-1.5px;background:#FFFAF0;border:1px solid #3B2433;border-radius:2px;box-sizing:border-box;transition:left .4s}
#hud .row[data-stat=temp] .felt{position:absolute;top:-4px;width:0;height:0;margin-left:-3px;border:3px solid transparent;border-top-color:#3B2433;transition:left .4s}
#hud .row[data-stat=temp] .tv{flex:none;min-width:30px;text-align:right;font-size:10px;white-space:nowrap}
#hud .row[data-stat=temp][data-band=cold] .tv{color:#5A9BFF}#hud .row[data-stat=temp][data-band=hot] .tv{color:#FF6A4A}
#hud [data-role=disease-chips]{display:flex;flex-wrap:wrap;gap:2px;margin-top:2px}#hud .dchip{font-size:9px;padding:1px 5px;border-radius:6px;border:1px solid #4A2F3D;color:#FFFAF0;text-shadow:0 1px 0 #3B2433;white-space:nowrap;display:inline-flex;align-items:center;gap:2px}
@media (max-height:420px){#hud{width:100px;padding:2px 4px;opacity:.9}#hud .bar{height:5px}#hud .row{margin:1px 0}#hud .row[data-stat=temp] .tv{min-width:26px;font-size:9px}}`;
  document.head.append(style);
  const root = document.createElement("div"); root.id = "hud";
  root.tabIndex = 0; root.setAttribute("role", "button"); root.setAttribute("aria-label", "Health stats — open character sheet");
  root.title = "Character sheet · K / LB + right stick click";
  root.addEventListener("click", (e) => { e.stopPropagation(); onCharacter?.(); });
  root.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onCharacter?.(); } });
  for (const event of ["pointerdown", "mousedown", "touchstart"]) root.addEventListener(event, (e) => e.stopPropagation());
  const clock = document.createElement("div"); clock.className = "clock"; root.append(clock);
  const clockIcon = document.createElement("img"); clockIcon.className = "ic"; clockIcon.alt = "";
  const clockText = document.createElement("span"); clockText.dataset["hud"] = "clock";
  const weatherText = document.createElement("span"); weatherText.dataset["hud"] = "weather";
  const seasonText = document.createElement("span"); seasonText.dataset["hud"] = "season";
  // Task 25: the season glyph is a custom icon (the text emoji is gone); the img is swapped per season in update().
  const seasonIcon = document.createElement("img"); seasonIcon.className = "ic"; seasonIcon.alt = ""; seasonText.append(seasonIcon);
  const left = document.createElement("span"); left.className = "l"; left.append(clockIcon, clockText, seasonText); clock.append(left, weatherText);
  const icons: HTMLImageElement[] = [];
  let ui: Awaited<ReturnType<typeof uiSprites>> | undefined;
  const fills = STATS.map((s) => {
    const row = document.createElement("div"); row.className = "row"; row.dataset["stat"] = s.key;
    const l = document.createElement("span"); l.className = "lab"; const ic = document.createElement("img"); ic.className = "ic"; ic.alt = s.key; ic.style.display = "none"; icons.push(ic); l.prepend(ic); const bar = document.createElement("div"); bar.className = "bar";
    const f = document.createElement("div"); f.className = "fill"; f.style.background = s.color; bar.append(f); row.append(l, bar); root.append(row); return f;
  });
  // ADR-239 temperature gauge: air-temperature marker on a cold→hot gradient, felt-temperature caret, "24°C" readout
  const tRow = document.createElement("div"); tRow.className = "row"; tRow.dataset["stat"] = "temp";
  const tLab = document.createElement("span"); tLab.className = "lab"; const tIc = document.createElement("img"); tIc.className = "ic"; tIc.alt = "temp"; tIc.style.display = "none"; tLab.prepend(tIc);
  const tBar = document.createElement("div"); tBar.className = "bar"; const tAir = document.createElement("i"); tAir.className = "air"; const tFelt = document.createElement("i"); tFelt.className = "felt"; const tGrad = document.createElement("i"); tGrad.className = "grad"; tBar.append(tGrad, tAir, tFelt); // gradient as a child so the bar_track nine-slice frame (fill) stays around it
  const tVal = document.createElement("span"); tVal.className = "tv"; tVal.dataset["hud"] = "temp";
  // ADR-312: the indoors / sheltered marker is the shelter chip in the status row (house icon + "Sheltered N%").
  tRow.append(tLab, tBar, tVal); root.append(tRow);
  // Task 13: one chip per active disease on the local player (replicated Diseases component); chips vanish on cure
  const chips = document.createElement("div"); chips.dataset["role"] = "disease-chips"; root.append(chips);
  let unit: TempUnit = ov.unit ?? loadTempUnit(), unitAt = 0, tempIcon = "", hudBottom = -1;
  // Task 14 smoothness: skip DOM writes whose value did not change. The 250 ms update used to rewrite every
  // text and bar width on every tick (style recalc + paint scheduling for zero visual change); the guards
  // for low icons, temp icons, disease chips and --hud-bottom already existed, these fields did not.
  const last = new Map<string, string>();
  const setText = (k: string, el: HTMLElement, v: string): void => { if (last.get(k) === v) return; last.set(k, v); el.textContent = v; };
  const setStyle = (k: string, el: HTMLElement, prop: "width" | "left" | "display", v: string): void => { if (last.get(k) === v) return; last.set(k, v); el.style[prop] = v; };
  const setAttr = (k: string, el: HTMLElement, prop: "title" | "band", v: string): void => { if (last.get(k) === v) return; last.set(k, v); if (prop === "title") el.title = v; else el.dataset["band"] = v; };
  mountUi(root);
  // Task 26 smoothness: the 250 ms tick used to read root.offsetHeight on every tick — a forced layout
  // for a value that only changes when the HUD's content changes (disease chips, icon swaps). Publish
  // --hud-bottom from a ResizeObserver instead (fires only when the size actually changes); without one
  // (jsdom / old browsers) fall back to measuring when the chips change and once at mount.
  const publishHudBottom = (): void => {
    const hb = root.offsetTop + root.offsetHeight + 4;
    if (root.offsetHeight > 0 && hb !== hudBottom) { hudBottom = hb; document.documentElement.style.setProperty("--hud-bottom", `${hb}px`); }
  };
  addEventListener("resize", publishHudBottom);
  const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  let ro: ResizeObserver | undefined;
  if (RO) { ro = new RO(() => publishHudBottom()); ro.observe(root); } else publishHudBottom();
  // Art's UI kit: panel_hud plaque, bar_track / bar_fill_* nine-slices, vital_* icons (falls back to the CSS look)
  void uiSprites(base).then((u) => {
    ui = u; const css: string[] = [];
    const nine = (sel: string, k: string, extra = ""): void => { const url = u.url(k), f = u.frame(k); if (!url || !f?.nineSlice) return; const n = f.nineSlice;
      css.push(`${sel}{border-style:solid;border-width:${n.t / 2}px ${n.r / 2}px ${n.b / 2}px ${n.l / 2}px;border-image:url(${url}) ${n.t} ${n.r} ${n.b} ${n.l} fill stretch;background:none;${extra}}`); };
    nine("#hud", "panel_hud", "border-radius:0;box-shadow:none;color:#FFFAF0;padding:2px 4px;text-shadow:0 1px 0 #3B2433");
    nine("#hud .bar", "bar_track", "border-radius:0;height:5px");
    SPRITE_KEYS.forEach((k, i) => nine(`#hud .row[data-stat="${STATS[i]!.key}"] .fill`, `bar_fill_${k}`, "border-radius:0;height:0;margin:-1px 0;box-sizing:border-box;min-width:7px"));
    css.push("#hud .clock{color:#FFE7A8}#hud .ic{width:13px;height:13px;vertical-align:middle;image-rendering:pixelated}#hud .l{display:flex;align-items:center;gap:3px}#hud .lab{display:flex;width:14px}");
    const st = document.createElement("style"); st.textContent = css.join("\n"); style.after(st);
    icons.forEach((ic, i) => { const url = u.url(`vital_${SPRITE_KEYS[i]}`) ?? iconUrl(STATS[i]!.icon); ic.src = url; ic.style.display = ""; ic.nextSibling?.remove(); });
    // Task 25: the thermometer falls back to the custom icon when the atlas has no icon_temp frame.
    if (u.url("icon_temp")) { tIc.style.display = ""; tIc.nextSibling?.remove(); }
    else { tIc.src = iconUrl("ic_temp.png"); tIc.style.display = ""; tIc.nextSibling?.remove(); tempIcon = "custom"; }
    update();
  });
  const update = (): void => {
    const w = world(); const p = player();
    try {
      const h = ov.hours ?? dayHours();
      const wk = ov.weather ?? w.env(Weather).kind;
      setText("clock", clockText, `${formatClock12(h)}${ov.hours !== undefined ? "*" : ""}`); // ADR-284: 12-hour AM/PM world clock
      setText("weather", weatherText, `${WEATHER_LABEL[wk] ?? "?"}${ov.weather !== undefined ? "*" : ""}`);
      setAttr("clockTitle", clock, "title", ov.hours !== undefined || ov.weather !== undefined ? "* view override (?time= / ?weather=)" : "");
      const sh = sunFractionFor(h / 24, sunScheduleNow(w, undefined, ov.season)) * 24; const night = sh < 6 || sh >= 19; // ADR-283: seasonal sunrise / sunset if (ui) { const u = ui.url(night ? "ic_moon" : "ic_sun"); if (u && clockIcon.dataset["k"] !== String(night)) { clockIcon.src = u; clockIcon.dataset["k"] = String(night); } }
    } catch { setText("clock", clockText, ""); setText("weather", weatherText, ""); }
    try { // ADR-239 season + temperature
      const days = dayCount(), si = ov.season !== undefined ? Math.floor(((ov.season % 4) + 4) % 4) : seasonAtDays(w, days).index;
      // Task 25: season is a custom icon (was the ☀/🍂/❄ text emoji).
      if (seasonIcon.dataset["k"] !== String(si)) { seasonIcon.dataset["k"] = String(si); seasonIcon.src = iconUrl(SEASON_ICON[si] ?? "ic_sun.png"); }
      setAttr("seasonTitle", seasonText, "title", `${SEASON_LABEL[si] ?? ""}${ov.season !== undefined ? " (view override ?season=)" : ""}`);
      const now = Date.now(); if (!ov.unit && now - unitAt > 1000) { unitAt = now; unit = loadTempUnit(); }
      const ovr = ov.season !== undefined || ov.hours !== undefined || ov.weather !== undefined;
      const air = hudAirTemp(w, ovr ? overrideDays(w, days, ov) : days, ov.weather);
      const ex = p !== undefined ? w.get(p, Exposure) : undefined;
      // view-only overrides (?season/?time/?weather) shift the replicated felt temp by the same air delta (clothing/shelter offset kept)
      const felt = ex ? (ovr ? ex.feltTemp + air - hudAirTemp(w, days) : ex.feltTemp) : undefined;
      // Task 23: indoors the gauge shows the sheltered air temperature (what the building does to the air);
      // outside it shows the air temperature as before. The outdoor air stays in the tooltip.
      const tf = p !== undefined ? w.get(p, Transform) : undefined;
      // Task 24: the indoor gauge includes the room's smoothed fire heat (RoomHeat, replicated).
      const fireHeat = p !== undefined && w.isRegistered(RoomHeat) ? (w.getField(p, RoomHeat, "heat") ?? 0) : 0;
      const indoor = !ovr && tf ? hudShelteredTemp(w, days, tf.x, tf.y, tf.z, undefined, fireHeat) : undefined;
      const indoors = indoor !== undefined && indoor.sheltered && Math.abs(indoor.temp - air) >= 1;
      const shown = indoors ? indoor!.temp : air;
      const band = tempBand(felt ?? shown); setAttr("band", tRow, "band", band);
      setStyle("airLeft", tAir, "left", `${(gaugeFrac(shown) * 100).toFixed(1)}%`); setText("tempVal", tVal, `${formatTemp(shown, unit)}`);
      if (felt !== undefined && Math.abs(felt - shown) >= 1) { setStyle("feltDisp", tFelt, "display", ""); setStyle("feltLeft", tFelt, "left", `${(gaugeFrac(felt) * 100).toFixed(1)}%`); } else setStyle("feltDisp", tFelt, "display", "none");
      setAttr("rowTitle", tRow, "title", `Air ${formatTemp(air, unit)}${indoors ? ` · ${indoor!.enclosed ? "indoors" : "sheltered"} ${formatTemp(indoor!.temp, unit)}` : ""}${felt !== undefined ? ` · feels like ${formatTemp(felt, unit)}` : ""}`);
      if (ui) { const k = band === "mild" ? "icon_temp" : `icon_temp_${band}`; const url = ui.url(k) ?? ui.url("icon_temp"); if (url && tempIcon !== k) { tIc.src = url; tempIcon = k; } }
    } catch { setText("tempVal", tVal, ""); }
    const hp = p !== undefined ? w.get(p, Health) : undefined, sv = p !== undefined ? w.get(p, Survival) : undefined;
    const vals = [hp ? hp.hp / (hp.max || 100) : 1, sv ? sv.hunger / 100 : 1, sv ? sv.thirst / 100 : 1, sv ? sv.stamina / (sv.maxStamina || 100) : 1];
    if (ui) vals.forEach((v, i) => { const low = v < 0.25; const ic = icons[i]!; if (ic.dataset["low"] !== String(low)) { const u = ui!.url(`vital_${SPRITE_KEYS[i]}${low ? "_low" : ""}`); if (u) { ic.src = u; ic.dataset["low"] = String(low); } } });
    vals.forEach((v, i) => { setStyle(`fill${i}`, fills[i]!, "width", `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`); });
    // Task 13: disease chips follow the replicated component (added / removed as diseases come and go).
    // Task 31: each chip carries its custom sprite, and a wet chip (droplet + %) shows while the player is wet.
    try {
      const actives = p !== undefined && w.isRegistered(Diseases) ? activeDiseases(w, p) : [];
      const wet = p !== undefined ? (w.getField(p, Exposure, "wetness") ?? 0) : 0;
      const stage = wetnessStage(wet), tier = sv ? temperatureTier(sv.bodyTemp) : undefined;
      const shelter = shelterChipState(p !== undefined ? (w.getField(p, Exposure, "sheltered") ?? 0) : 0);
      const keys = `${ui ? "atlas" : "loading"}|${actives.map((d) => d.key).join(",")}|${stage}|${tier}|${p !== undefined ? infectionTier(w, p) : ""}|${shelter.show ? shelter.pct : ""}`;
      if (chips.dataset["keys"] !== keys) {
        chips.dataset["keys"] = keys; chips.innerHTML = "";
        for (const d of actives) { const shown = diseasePresentation(w, p!, d); const c = document.createElement("span"); c.className = "dchip"; c.dataset["disease"] = d.key; if (shown.stage) c.dataset["status"] = shown.stage; c.append(conditionIconImg(shown.icon, 11, shown.name), ` ${shown.short}`); c.title = shown.name + (shown.stage === "septic" ? " — losing health! Use a medicated bandage." : shown.stage ? " — treat before it worsens; medicated bandages cure infection." : ""); c.style.background = d.color; chips.append(c); }
        const status = (key: string, title: string, color: string): void => {
          const c = document.createElement("span"); c.className = "dchip"; c.dataset["status"] = key;
          const name = key[0]!.toUpperCase() + key.slice(1);
          c.append(conditionIconImg(key, 11, name), ` ${name}`); c.title = title; c.style.background = color; chips.append(c);
        };
        if (tier) status(tier, `${tier} — body ${formatBodyTemp(sv!.bodyTemp, unit)}. ${damagingTemperatureTier(tier) ? "Losing health!" : "Find comfortable shelter before this worsens."}`, tier === "chilly" || tier === "cold" || tier === "freezing" ? "#386DA6" : "#AC432B");
        if (stage) status(stage, `${stage} — dry indoors or by a fire; deeper wetness takes longer to dry`, "#4A7A9E");
        if (shelter.show) { // ADR-312: protected from the elements by surrounding base pieces
          const c = document.createElement("span"); c.className = "dchip"; c.dataset["status"] = "sheltered"; c.dataset["shelter"] = shelter.full ? "full" : "partial";
          const ic = iconImg("ic_house.png", 11, "Sheltered"); if (!shelter.full) ic.style.opacity = String(0.55 + 0.45 * (shelter.pct / 100));
          c.append(ic, ` ${shelter.label}`);
          c.title = shelter.full ? "Indoors — fully protected from rain, wind and sun" : `${shelter.label} from the elements — a roof keeps rain off; walls and closed doors block wind and cold`;
          c.style.background = shelter.full ? "#4E7A3A" : "#7A6A3E"; chips.append(c);
        }
        if (!ro) publishHudBottom(); // no ResizeObserver: chips are the only content that changes the HUD height
      }
    } catch { /* replica without Diseases yet */ }
  };
  const timer = setInterval(update, 250); update();
  // ADR-282: a unit change in Settings re-renders the gauge at once (the 1 s poll stays as a cross-tab fallback)
  const onUnit = (): void => { if (!ov.unit) { unit = loadTempUnit(); unitAt = Date.now(); try { update(); } catch { /* never break the HUD */ } } };
  addEventListener(TEMP_UNIT_EVENT, onUnit);
  return { destroy: () => { clearInterval(timer); removeEventListener("resize", publishHudBottom); removeEventListener(TEMP_UNIT_EVENT, onUnit); ro?.disconnect(); root.remove(); style.remove(); } };
}
