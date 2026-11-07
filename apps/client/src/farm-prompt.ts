/**
 * ADR-110 follow-up: on-screen farming context prompt (Till / Plant / Water / Fertilize / Harvest) and short failure toasts.
 * The prompt names the key for the active device (keyboard / gamepad binding of QuickUse, or Interact for Harvest) and is
 * a tappable button on touch. Pure decisions live in @engine/gameplay farmPrompt; this is DOM only.
 * Hooks: `#farm-prompt` (`data-action`, `data-fail`), `#farm-toast`.
 */
import { FARM_FAIL_TEXT, FarmFail, cropInspection, farmPrompt, husbandryPrompt, TameFail, treesOf, treeShortName, type FarmPrompt } from "@engine/gameplay";
import type { Entity, World } from "@engine/core";

/** "key.KeyX" -> "X", "pad.b" -> "B", "mouse.left" -> "LMB". */
export function controlLabel(control: string | undefined): string {
  if (!control) return "";
  const [dev, c = ""] = control.split(/\.(.*)/s) as [string, string];
  if (dev === "key") return c.replace(/^Key|^Digit/, "");
  if (dev === "pad") return c.toUpperCase();
  if (dev === "mouse") return c === "left" ? "LMB" : c === "right" ? "RMB" : c;
  return "";
}
export type PromptDevice = "keyboardMouse" | "gamepad" | "touch";
export const promptText = (p: FarmPrompt, keyLabel: string, device: PromptDevice): string =>
  device === "touch" || !keyLabel ? p.label : `[${keyLabel}] ${p.label}`;

export interface FarmPromptDeps {
  world: () => World; player: () => Entity | undefined; device: () => PromptDevice;
  /** binding label for an action on the active device */ key: (action: "QuickUse" | "Interact") => string;
  hidden: () => boolean; use: (p: FarmPrompt) => void;
}
/** Keyboard / gamepad QuickUse press: Harvest stays on Interact (gather), so only the Use actions fire here. */
export const quickUseFires = (p: FarmPrompt | undefined): boolean => !!p && p.action !== "Harvest";
export function mountFarmPrompt(root: HTMLElement, d: FarmPromptDeps): { destroy(): void; toast(text: string): void; trigger(): void } {
  const style = document.createElement("style");
  style.textContent = `#plant-inspect{position:absolute;left:50%;bottom:calc(110px + var(--sab,0px));transform:translateX(-50%);z-index:5;width:min(280px,calc(100% - 24px));display:flex;flex-direction:column;align-items:stretch;gap:6px;pointer-events:none}#farm-prompt{font:600 13px Fredoka,system-ui,sans-serif;color:#FFFAF0;background:rgba(20,16,12,.72);border:2px solid #E6C47E;border-radius:10px;padding:6px 12px;pointer-events:none;white-space:normal;overflow-wrap:anywhere;width:100%;box-sizing:border-box}
#farm-prompt[data-touch="true"]{pointer-events:auto;min-height:44px;min-width:88px;cursor:pointer}#farm-prompt[data-fail]:not([data-fail="0"]){border-color:#C0584A;color:#FFD6C8}
#crop-bars{font:600 12px Fredoka,system-ui,sans-serif;color:#FFFAF0;background:rgba(20,16,12,.85);border:2px solid #E6C47E;border-radius:10px;padding:7px 10px;box-sizing:border-box}
#crop-bars[hidden],#crop-bars [hidden]{display:none}#crop-bars .crop-name{text-transform:capitalize;margin-bottom:4px}#crop-bars .crop-row{display:grid;grid-template-columns:65px 1fr 38px;gap:7px;align-items:center;min-height:19px}#crop-bars .crop-track{height:7px;background:#211e19;border:1px solid #ad9670;border-radius:4px;overflow:hidden}#crop-bars .crop-fill{display:block;height:100%;background:var(--crop-color)}#crop-bars .crop-value{text-align:right;font-size:11px}
@media(max-width:600px){#plant-inspect{top:calc(140px + var(--sat,0px));bottom:auto;width:min(240px,calc(100% - 24px))}}
#farm-toast{position:absolute;left:50%;top:calc(18% + var(--sat,0px));transform:translateX(-50%);z-index:6;font:600 13px Fredoka,system-ui,sans-serif;color:#FFFAF0;background:rgba(80,30,24,.85);border-radius:8px;padding:6px 12px;pointer-events:none;transition:opacity .3s}`;
  document.head.append(style);
  const btn = document.createElement("button"); btn.type = "button"; btn.id = "farm-prompt"; btn.style.display = "none";
  const toastEl = document.createElement("div"); toastEl.id = "farm-toast"; toastEl.setAttribute("role", "status"); toastEl.style.opacity = "0";
  const inspect = document.createElement("div"); inspect.id = "plant-inspect";
  const bars = document.createElement("div"); bars.id = "crop-bars"; bars.hidden = true;
  const name = document.createElement("div"); name.className = "crop-name"; bars.append(name);
  const rows = ([ ["Growth", "#85c66b"], ["Water", "#66b8ed"], ["Fertilizer", "#d8a45a"] ] as const).map(([label, color]) => {
    const row = document.createElement("div"); row.className = "crop-row"; row.dataset["bar"] = label.toLowerCase();
    const text = document.createElement("span"); text.textContent = label;
    const track = document.createElement("div"); track.className = "crop-track"; track.setAttribute("role", "progressbar"); track.setAttribute("aria-label", label); track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100");
    const fill = document.createElement("span"); fill.className = "crop-fill"; fill.style.setProperty("--crop-color", color); track.append(fill);
    const value = document.createElement("span"); value.className = "crop-value"; row.append(text, track, value); bars.append(row);
    return { row, track, fill, value };
  });
  inspect.append(bars, btn); root.append(inspect, toastEl);
  const updateBars = (): void => {
    const p = d.player(); const state = d.hidden() || p === undefined ? undefined : cropInspection(d.world(), p);
    bars.hidden = !state; if (!state) return;
    name.textContent = state.name; bars.dataset["target"] = String(state.target);
    [state.growth, state.hydration, state.fertilizer].forEach((fraction, i) => {
      const r = rows[i]!; r.row.hidden = i === 2 && fraction <= 0;
      const percent = Math.round(fraction * 100); r.fill.style.width = `${fraction * 100}%`;
      r.track.setAttribute("aria-valuenow", String(percent));
      r.value.textContent = i === 0 && fraction >= 1 ? "Done" : i === 1 && fraction <= 0 ? "Dry" : `${percent}%`;
    });
  };
  let cur: FarmPrompt | undefined; let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = (text: string): void => { toastEl.textContent = text; toastEl.style.opacity = "1"; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.opacity = "0"; }, 1800); };
  const read = (): FarmPrompt | undefined => {
    const p = d.player(); if (p === undefined) return undefined;
    try {
      const f = farmPrompt(d.world(), p); if (f) return f;
      const h = husbandryPrompt(d.world(), p); // ADR-113 Tame / Feed with animal_feed in hand
      return h ? { action: h.action as FarmPrompt["action"], slot: h.slot, fail: h.fail === TameFail.None ? FarmFail.None : FarmFail.NothingToTend, label: h.label } : undefined;
    } catch { return undefined; }
  };
  let lastLevels: number[] | undefined; // ADR-113/206 per-tree level-up toast (Progression replicates; polled with the prompt)
  const levelCheck = (): void => {
    const p = d.player(); const tr = p === undefined ? undefined : treesOf(d.world(), p); if (!tr) { lastLevels = undefined; return; }
    if (lastLevels) for (let i = 0; i < tr.length; i++) { const t = tr[i]!; if (t.level > (lastLevels[i] ?? t.level)) { toastEl.dataset["kind"] = "levelup"; toast(`${treeShortName(i)} level ${t.level}! ${t.points} ${treeShortName(i)} point${t.points === 1 ? "" : "s"} — open Skills`); } }
    lastLevels = tr.map((t) => t.level);
  };
  const trigger = (): void => {
    const p = read(); if (!p) return;
    if (p.fail !== FarmFail.None) { toast(p.action === "Tame" || p.action === "Feed" ? p.label.replace(/^\w+: /, "") : FARM_FAIL_TEXT[p.fail] ?? "Can't do that here"); return; }
    d.use(p);
  };
  const update = (): void => {
    levelCheck(); updateBars();
    cur = d.hidden() ? undefined : read();
    if (!cur) { btn.style.display = "none"; return; }
    const dev = d.device();
    btn.style.display = ""; btn.dataset["action"] = cur.action; btn.dataset["fail"] = String(cur.fail); btn.dataset["touch"] = String(dev === "touch");
    btn.textContent = promptText(cur, d.key(cur.action === "Harvest" ? "Interact" : "QuickUse"), dev);
  };
  btn.addEventListener("click", (ev) => { ev.preventDefault(); trigger(); });
  const timer = setInterval(update, 200); update();
  return { toast, trigger, destroy: () => { clearInterval(timer); clearTimeout(toastTimer); inspect.remove(); toastEl.remove(); style.remove(); } };
}
