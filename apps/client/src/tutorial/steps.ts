/**
 * ADR-144 tutorial lessons. Pure (no DOM): text uses tokens that the overlay turns into live binding chips:
 *   {A:Action} or {A:Action@Context}  the controls bound to an input action on the active device
 *   {M:menuId}                        how to open a game menu on the active device
 * ADR-275 contextual tips: the old start-to-finish guide is split into one-topic lessons. Each lesson has a `when`
 * trigger (an absolute "has this ever happened" probe check) and shows once, the first time its moment comes up:
 * opening a menu, first gathering, first log, first craft, first build piece, first skill point, getting hungry,
 * a zombie nearby, a broken leg, and so on. Only the Walk tip shows at spawn. "do" lessons finish when the probe
 * shows the player did the thing; "info" lessons wait for Got it. Dismissed lessons never come back (unless the
 * player picks "Play the guide again", which clears the seen list).
 */
import type { TutDevice } from "./labels.js";

/** Counters and values sampled from the game a few times a second (see main.ts tutorialProbe). */
export type Probe = Readonly<Record<string, number>>;
export type StepText = string | ({ all?: string } & Partial<Record<TutDevice, string>>);
export interface TutStep {
  /** Touch: draw a ghost hint (e.g. the floating joystick, which only shows once touched) and ring it when the real control is not on screen. */
  ghost?: "joystick";
  id: string; section: string; title: string; text: StepText;
  /** Finishes the lesson when true (cur vs. the probe when the lesson appeared). Missing = info card (Got it). */
  done?: (cur: Probe, base: Probe) => boolean;
  /** CSS selector of the UI element to spotlight (per device). */
  target?: (d: TutDevice) => string | undefined;
  /** ADR-275 trigger: the lesson waits (hidden) until this is true. Missing = shows right away (only the first Walk tip). */
  when?: (p: Probe) => boolean;
  /** ADR-275: only after this other lesson was seen (keeps related tips from arriving at once). */
  after?: string;
}
const grew = (k: string, by = 1) => (c: Probe, b: Probe): boolean => (c[k] ?? 0) - (b[k] ?? 0) >= by;
/** Absolute trigger: the probe counter has ever reached `n` (e.g. the player has ever opened the Build menu). */
const has = (k: string, n = 1) => (p: Probe): boolean => (p[k] ?? 0) >= n;
const either = (...ks: string[]) => (p: Probe): boolean => ks.some((k) => (p[k] ?? 0) >= 1);
const any = (...fs: ((c: Probe, b: Probe) => boolean)[]) => (c: Probe, b: Probe): boolean => fs.some((f) => f(c, b));
const touchOr = (touchSel: string, other?: string) => (d: TutDevice): string | undefined => d === "touch" ? touchSel : other;
const menuBtn = (id: string) => (): string => `#game-menubar [data-open=${id}]`;
const stat = (k: string) => (): string => `#hud [data-stat=${k}]`;

export const TUTORIAL_STEPS: readonly TutStep[] = [
  // ---- moving ----
  { id: "move", section: "Start", title: "Welcome to SurVivaZ!", text: "Walk around with {A:Move}. Short tips pop up as you find new things.", done: grew("moved", 3), target: touchOr("[data-touch=move]"), ghost: "joystick" },
  { id: "sprint", section: "Move", title: "Run", text: { all: "Keep moving in one direction for a moment to start running. You can turn while running; stop moving to walk again. Running uses stamina ⚡." }, done: grew("sprint", 3), target: stat("stamina"), when: has("moved", 25) },
  { id: "look", section: "Move", title: "Look around", text: { keyboardMouse: "Zoom in or out with {A:Camera.Zoom}.", gamepad: "Aim with {A:Aim}. Zoom with {A:Camera.Zoom}.", touch: "Zoom in or out: {A:Camera.Zoom}." }, done: any(grew("zoom"), grew("aim", 20)), when: has("moved", 60) },
  // ---- gathering + bag ----
  { id: "gather", section: "Gather", title: "Pick things up", text: { all: "Walk up to a bush, stick or rock. A hand ✋ means you can take it with bare hands. Press {A:Interact} to gather.", gamepad: "Walk up to a bush, stick or rock. A hand ✋ means you can take it with bare hands. Hold {A:Interact} to gather." }, done: grew("gain"), target: (d) => d === "touch" ? "[data-touch=context]" : "#tool-hint", when: has("nearNode") },
  { id: "inventory", section: "Gather", title: "Your bag", text: "Open your bag with {M:inventory}.", done: grew("menu:inventory"), target: menuBtn("inventory"), when: has("gain") },
  { id: "bag-info", section: "Gather", title: "Your bag", text: "All your items live here. Pick an item to see what it does.", target: () => ".gm-modal[data-modal=inventory] .gm-panel", when: has("menu:inventory") },
  { id: "hunger", section: "Stay alive", title: "Hunger 🍖", text: "This bar shows how full you are. When it is empty, you get hurt. Eat food to fill it.", target: stat("hunger"), when: has("hungry") },
  { id: "thirst", section: "Stay alive", title: "Thirst 💧", text: "This bar shows your water. It goes down faster than food. Drink often.", target: stat("thirst"), when: has("thirsty") },
  { id: "eat", section: "Gather", title: "Eat and drink", text: { all: "Eat or drink something. Pick food or water in your bag and choose Use. You can also drink at a lake with {A:QuickUse}.", touch: "Eat or drink something. Pick food or water in your bag and choose Use. You can also drink at a lake with the {A:QuickUse}." }, done: grew("eat"), target: stat("hunger"), when: either("hungry", "thirsty") },
  // ---- crafting ----
  { id: "craft", section: "Craft", title: "Make things", text: "Open crafting with {M:crafting}. You only see things you can make by hand here. Pick one to make it.", done: grew("craft"), target: menuBtn("crafting"), when: has("gain", 4) },
  { id: "craft-station", section: "Craft", title: "Stations", text: "Bigger things need a station, like a campfire or a workbench. Those recipes are at the station.", when: has("stationBuilt") },
  { id: "equip", section: "Craft", title: "Hotbar items", text: { all: "Hold a tool, like a stone axe. Pick it in your hotbar with {A:Hotbar1}, or choose Equip in your bag.", gamepad: "Hold a tool, like a stone axe. Pick it with {A:Hotbar1}, or choose Equip in your bag.", touch: "Tap a hotbar slot to switch items. Double-tap a slot to use an item or equip a tool." }, target: () => "#hotbar", done: (c) => (c["tool"] ?? 0) > 0, when: has("craft") },
  { id: "chop", section: "Craft", title: "Chop a tree", text: "Stand next to a tree. Hold {A:Primary} to chop it. You get logs.", done: grew("gainLog"), target: touchOr("[data-touch=attack]"), when: has("hadTool") },
  // ---- building ----
  { id: "build", section: "Build", title: "Build mode", text: { all: "Open build mode with {A:ToggleBuild}. Pick the campfire.", touch: "Tap the {A:ToggleBuild}. Pick the campfire." }, done: grew("build"), target: menuBtn("build"), when: has("gainLog") },
  { id: "rotate", section: "Build", title: "Turn it", text: "Turn the piece with {A:Build.RotateCW@Building}.", done: grew("rotate"), target: touchOr("[data-touch=rotate]"), when: has("build"), after: "ghost" },
  { id: "ghost", section: "Build", title: "Green or red", text: "Green means you can build here. Red means you can't. The red note tells you why, like \"Too far away\".", target: () => ".build-hud .bh-chip", when: either("build", "menu:build") },
  { id: "place", section: "Build", title: "Place it", text: "Put it down with {A:Build.PlaceConfirm@Building}.", done: grew("place"), target: touchOr("[data-touch=confirm]", ".build-hud .bh-chip"), when: has("build"), after: "rotate" },
  { id: "roads", section: "Build", title: "Roads and signs", text: { keyboardMouse: "Lay roads with {A:RoadTool}. Put up signs with {A:PlaceSign}. Both are in the Build menu too.", all: "Roads and signs are in the Build menu. Roads help you find your way home." }, when: has("place") },
  { id: "station", section: "Build", title: "Use a station", text: "Walk to your campfire. Press {A:Interact} to use it. Light it to cook food.", done: grew("menu:station"), target: touchOr("[data-touch=context]"), when: has("campfire") },
  { id: "skills", section: "Grow", title: "Skills", text: "Open skills with {M:skills}.", done: grew("menu:skills"), target: menuBtn("skills"), when: has("skillPoint") },
  { id: "skills-info", section: "Grow", title: "XP and levels", text: { all: "You get XP when you gather, craft and fight. Each new level gives you a skill point. Use the tabs on top to see each group.", gamepad: "You get XP when you gather, craft and fight. Each new level gives you a skill point. Switch tabs with {A:UI.TabNext@Inventory}." }, target: () => ".gm-modal[data-modal=skills] .gm-panel", when: has("menu:skills") },
  // ---- staying alive ----
  { id: "health", section: "Stay alive", title: "Health ❤", text: "This is your health. Hits and hunger take it away. Eat, drink and rest to get it back. Open your character details with {M:character}.", target: stat("hp"), when: has("hurt") },
  { id: "stamina", section: "Stay alive", title: "Stamina ⚡", text: "Running, chopping and fighting use stamina. Stop for a moment and it comes back.", target: stat("stamina"), when: has("tired") },
  { id: "daynight", section: "Stay alive", title: "Day and night", text: "The clock shows the time. Nights are dark and more dangerous. A campfire gives you light.", target: () => "#hud .clock", when: has("dusk") },
  { id: "zombies", section: "Stay alive", title: "Zombies", text: "Zombies walk the land. Many come out at dusk and at night. Keep your distance or fight back.", when: has("zombieNear") },
  { id: "hordes", section: "Stay alive", title: "Hordes", text: "After a few safe days, big groups of zombies called hordes can come for your camp. Build walls before then.", when: has("day", 2) },
  { id: "fight", section: "Stay alive", title: "Fight", text: "Hit with {A:Primary}. A bar over an enemy shows its health. Tools and weapons hit harder than fists.", target: touchOr("[data-touch=attack]"), when: has("zombieClose") },
  // ADR-244 stances: block / aim, crouch, carry, sleep (controls help reads the live bindings per device).
  { id: "block", section: "Stay alive", title: "Block and aim", text: { all: "Hold {A:Secondary} to block with a melee weapon, shield or fists. It cuts melee damage but uses stamina and slows you. With a bow or gun, hold it to aim.", touch: "Hold {A:Secondary} to block. With a bow or gun it aims." }, target: touchOr("[data-touch=secondary]"), when: has("zombieClose"), after: "fight" },
  { id: "crouch", section: "Stay alive", title: "Sneak", text: { all: "Press {A:Crouch} to crouch. Press it again to stand. You move slower, but you are quieter and zombies see you later.", touch: "Tap {A:Crouch} to crouch or stand. Crouching is slower but quieter." }, target: touchOr("[data-touch=crouch]"), when: either("zombieNear", "night"), after: "zombies" },
  { id: "carry", section: "Stay alive", title: "Carry a bag", text: { all: "Stand by a loot bag and press {A:Carry} to lift it. You walk slower and can't fight or run. Press {A:Carry} or {A:Interact} to drop it.", touch: "Near a loot bag, a Carry button shows up. Tap it to lift the bag, then tap Drop to put it down." }, when: has("nearBag") },
  { id: "sleep", section: "Stay alive", title: "Sleep", text: { all: "Stand by a bed and press {A:Rest} to sleep. You get back health and stamina. When every player sleeps at night, time goes faster until morning. Any key, or a hit, wakes you.", touch: "Near a bed, a Sleep button shows up. Sleep to heal. Tap Wake, or anything else, to get up." }, when: either("nearBed", "night") },
  { id: "death", section: "Stay alive", title: "If you die", text: "If your health runs out, you die. Your items drop in a bag where you fell. Come back and pick them up.", when: has("respawned") },
  { id: "save", section: "Stay alive", title: "Saving", text: { all: "The game saves by itself. It also saves when you quit from the Menu." }, when: has("menu:pause") },
  // ---- social ----
  { id: "chat", section: "Friends", title: "Chat", text: "Talk to other players with {M:chat}.", target: menuBtn("chat"), when: has("menu:chat") },
  { id: "party", section: "Friends", title: "Party", text: "A party is a small team. Open it with {M:party} to invite a friend.", target: menuBtn("party"), when: has("menu:party") },
  { id: "clan", section: "Friends", title: "Clan", text: "A clan is a big group with ranks. Open it with {M:clan}.", when: has("menu:clan") },
  { id: "trade", section: "Friends", title: "Trade stalls", text: "Build a stall to sell your items. Walk up to a stall and press {A:Interact} to buy.", when: has("menu:trade") },
  { id: "settings", section: "Friends", title: "Settings", text: "Change sound, graphics and more in {M:settings}. You can play this guide again there.", when: either("menu:settings", "menu:pause") },
  // ---- ADR-275: new moments that deserve a tip (recently shipped features) ----
  { id: "skill-unlock", section: "Grow", title: "New skill", text: "You learned a skill! Its bonus works right away. Level up to earn points for more.", when: has("skillNode") },
  { id: "broken-leg", section: "Stay alive", title: "Broken leg 🦴", text: "That fall broke your leg. You move at half speed for a while. Craft a Leg Splint (2 sticks, 2 cloth) and use it to heal.", when: has("brokenLeg") },
];

export type TutStatus = "active" | "done" | "skipped";
/** v1 = the old linear guide (step = cursor). v2 = ADR-275 contextual tips (seen = dismissed lesson ids). */
export interface TutSave { status: TutStatus; step: string; v: 1 | 2; seen?: string[] }
export interface TutStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }
export const tutorialKey = (slot: string): string => `survivaz-tutorial-${slot}`;
/** ADR-275: the pre-split guide's order, used to migrate a half-finished v1 save (everything before its cursor counts as seen). */
export const LEGACY_ORDER: readonly string[] = ["welcome", "move", "sprint", "look", "gather", "inventory", "bag-info", "eat", "craft", "craft-station", "equip", "chop", "build", "rotate", "ghost", "place", "roads", "station", "skills", "skills-info", "hunger", "thirst", "health", "stamina", "daynight", "zombies", "hordes", "fight", "block", "crouch", "carry", "sleep", "death", "save", "chat", "party", "clan", "trade", "settings", "done"];
/** ADR-275: quiet time after a tip is dismissed before the next triggered one shows (no back-to-back tip floods). */
export const TIP_GAP_MS = 4000;

/**
 * ADR-275 contextual lesson queue with save/resume. `gated(p)` picks the lesson to show (the first unseen one whose
 * trigger fired, after the quiet gap) and is true while there is nothing to show. `observe` finishes "do" lessons.
 * A save that finished or skipped the old all-at-once guide marks every lesson seen, so old characters get no flood.
 */
export class TutorialProgress {
  private i = -1; private base: Probe | undefined; status: TutStatus | undefined; readonly seen = new Set<string>();
  private quietUntil = 0;
  constructor(readonly steps: readonly TutStep[], private readonly store: TutStorage | undefined, private readonly key: string,
    private readonly opts: { gapMs?: number; now?: () => number } = {}) {
    const s = this.load();
    if (s) {
      this.status = s.status;
      if (s.v === 2) for (const id of s.seen ?? []) this.seen.add(id);
      else if (s.status !== "active") for (const x of steps) this.seen.add(x.id); // finished / skipped the old guide: no tip flood
      else { const j = LEGACY_ORDER.indexOf(s.step); for (const id of LEGACY_ORDER.slice(0, Math.max(0, j))) this.seen.add(id); }
      if (s.v === 2) { const j = steps.findIndex((x) => x.id === s.step); if (j >= 0 && !this.seen.has(s.step)) this.i = j; }
    }
  }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private load(): TutSave | undefined {
    try { const j = JSON.parse(this.store?.getItem(this.key) ?? "null") as TutSave | null; return j && (j.status === "active" || j.status === "done" || j.status === "skipped") ? j : undefined; } catch { return undefined; }
  }
  private save(): void { try { if (this.status) this.store?.setItem(this.key, JSON.stringify({ status: this.status, step: this.i >= 0 ? this.steps[this.i]!.id : "", v: 2, seen: [...this.seen] } satisfies TutSave)); } catch { /* private mode */ } }
  /** True when tips should run by themselves: never seen on this slot and this is a new game, or left running. */
  shouldAutoStart(newGame: boolean): boolean { return this.status === "active" || (this.status === undefined && newGame); }
  /** Index of the lesson on screen (-1 = none waiting). */
  get index(): number { return this.i; }
  /** The lesson on screen, else the next unseen one (for labels), else the last lesson. */
  get step(): TutStep { return this.steps[this.i] ?? this.steps.find((x) => !this.seen.has(x.id)) ?? this.steps[this.steps.length - 1]!; }
  get active(): boolean { return this.status === "active"; }
  /** Start the tips. `fromStart` (Play the guide again) clears the seen list so every lesson can come up again. */
  start(fromStart = false): void { if (fromStart) this.seen.clear(); if (fromStart || this.status !== "active") this.i = -1; this.status = "active"; this.base = undefined; this.quietUntil = 0; this.save(); }
  /** Force a lesson on screen (tests / QA). */
  go(i: number): void { this.i = Math.max(0, Math.min(this.steps.length - 1, i)); this.base = undefined; this.save(); }
  /** Dismiss the lesson on screen (Got it / done / skip this tip): it never shows again. */
  next(): void {
    if (this.i >= 0) this.seen.add(this.steps[this.i]!.id);
    this.i = -1; this.base = undefined; this.quietUntil = this.now() + (this.opts.gapMs ?? TIP_GAP_MS);
    if (this.steps.every((x) => this.seen.has(x.id))) { this.finish(); return; }
    this.save();
  }
  /** Turn the tips off for this character. */
  skip(): void { this.i = -1; this.status = "skipped"; this.save(); }
  finish(): void { this.i = -1; this.status = "done"; this.save(); }
  /** Lessons whose trigger fired but which have not been seen yet (in priority order). */
  pending(p: Probe): TutStep[] { return this.steps.filter((x) => !this.seen.has(x.id) && (!x.after || this.seen.has(x.after)) && (!x.when || x.when(p))); }
  /** True while nothing should show; otherwise picks the lesson to show (sticky until dismissed). */
  gated(p: Probe): boolean {
    if (!this.active) return true;
    if (this.i >= 0) return false;
    if (this.now() < this.quietUntil) return true;
    const s = this.pending(p)[0]; if (!s) return true;
    this.i = this.steps.indexOf(s); this.base = undefined; this.save(); return false;
  }
  observe(p: Probe): boolean {
    if (!this.active || this.gated(p)) return false;
    const s = this.step; if (!s.done) return false;
    if (!this.base) this.base = { ...p };
    if (s.done(p, this.base)) { this.next(); return true; }
    return false;
  }
}
