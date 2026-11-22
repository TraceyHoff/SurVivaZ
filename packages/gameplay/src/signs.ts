/**
 * ADR-120 craftable signage. A sign is a standalone entity (Transform + Sign) placed from a sign item; its text is
 * sanitized (printable ASCII, collapsed spaces), length-limited per kind (<= SIGN_TEXT_MAX) and profanity-masked
 * on the server. Owner or owner's clan may edit / remove it. Networked so every client renders a world label.
 */
import { refundOrDrop } from "./overflow.js";
import { defineCommand, entityIndex, Membership, PlayerId, Transform, type CommandDef, type CommandHandlers, type Entity, type World } from "@engine/core";
import { emit, XpActivity } from "./events.js";
import raw from "../data/roads.json";
import { Sign, SIGN_TEXT_MAX } from "./components.js";
import { countItem, removeItem } from "./inventory.js";
import { hasPrivilege } from "./building/place.js";
import { indexEntity } from "./spawn.js";
import { itemIdSafe } from "./roads.js";

const pid = (world: World, e: Entity): number => (world.isRegistered(PlayerId) ? world.getField(e, PlayerId, "id") ?? 0 : 0);
export interface SignDef { key: string; name: string; item: string; maxLen: number; wall: boolean }
export const SIGNS = raw.signs as SignDef[];
export const signDef = (kind: number): SignDef | undefined => SIGNS[kind - 1];
export const signKindOf = (key: string): number => SIGNS.findIndex((d) => d.key === key) + 1;
export const enum SignFail { None = 0, BadKind = 1, NoItem = 2, NoPrivilege = 3, NotOwner = 4, NotFound = 5, TooFar = 6 }
export const SIGN_FAIL_REASONS = ["", "bad_kind", "no_item", "no_privilege", "not_owner", "not_found", "too_far"] as const;

// Small built-in list; matched after leetspeak folding on letters only, so "f.u.c.k" / "sh1t" are caught too.
const BAD = ["fuck", "shit", "cunt", "bitch", "nigger", "nigga", "faggot", "fag", "retard", "whore", "slut", "dick", "cock", "pussy", "asshole", "bastard", "kike", "spic", "chink", "twat", "wank"];
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "l" };
/** Masks profanity with '*', keeping length and non-letter characters. */
export function maskProfanity(text: string): string {
  // folded letters + their source positions (skip separators inside words so "f u c k" / "f.u.c.k" are caught)
  const chars: string[] = []; const pos: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!.toLowerCase(); const f = LEET[c] ?? c;
    if (f >= "a" && f <= "z") { chars.push(f); pos.push(i); }
  }
  const folded = chars.join(""); const out = text.split("");
  for (const w of BAD) {
    let at = folded.indexOf(w);
    while (at >= 0) {
      // short words only when standing alone (avoid "Scunthorpe"-style false positives for 3-4 letter words)
      const start = pos[at]!, end = pos[at + w.length - 1]!;
      const before = start > 0 ? text[start - 1]! : " ", after = end + 1 < text.length ? text[end + 1]! : " ";
      const isolated = !/[a-z]/i.test(before) && !/[a-z]/i.test(after);
      if (w.length >= 5 || isolated) for (let k = at; k < at + w.length; k++) out[pos[k]!] = "*";
      at = folded.indexOf(w, at + 1);
    }
  }
  return out.join("");
}
/** Printable ASCII only, whitespace collapsed, trimmed, capped at maxLen (kind's limit), profanity masked. */
export function sanitizeSignText(rawText: string, maxLen = SIGN_TEXT_MAX): string {
  const t = rawText.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, Math.min(maxLen, SIGN_TEXT_MAX)).trimEnd();
  return maskProfanity(t);
}
export function signText(world: World, e: Entity): string {
  const n = world.getField(e, Sign, "len") ?? 0; const a = world.getArray(e, Sign, "text"); if (!a) return "";
  let o = ""; for (let i = 0; i < Math.min(n, SIGN_TEXT_MAX); i++) o += String.fromCharCode(a[i] ?? 32); return o;
}
function writeText(world: World, e: Entity, text: string): void {
  const a = world.getArray(e, Sign, "text")!; for (let i = 0; i < SIGN_TEXT_MAX; i++) a[i] = i < text.length ? text.charCodeAt(i) : 0;
  world.setField(e, Sign, "len", text.length); world.store(Sign).markChanged(entityIndex(e));
}
const clanOfActor = (world: World, e: Entity): number => (world.isRegistered(Membership) ? world.getField(e, Membership, "clanId") ?? 0 : 0);
/** Owner, or a member of the clan the sign was placed under. */
export function canEditSign(world: World, actor: Entity, sign: Entity): boolean {
  const s = world.get(sign, Sign); if (!s) return false;
  const me = pid(world, actor); const clan = clanOfActor(world, actor);
  return (me !== 0 && s.owner === me) || (s.clan !== 0 && clan === s.clan);
}
/** Raw spawn (no checks / cost). */
export function spawnSign(world: World, kind: number, x: number, y: number, rot = 0, owner = 0, clan = 0, text = ""): Entity {
  const e = world.create();
  world.add(e, Transform, { x, y }).add(e, Sign, { kind, rot: rot & 3, owner, clan, len: 0 });
  if (text) writeText(world, e, sanitizeSignText(text, signDef(kind)?.maxLen));
  indexEntity(world, e); return e;
}
/** Place a sign from the actor's inventory (consumes 1 sign item). */
export function placeSign(world: World, e: Entity, kind: number, x: number, y: number, rot: number, text = ""): { fail: SignFail; sign?: Entity } {
  const d = signDef(kind); if (!d) return { fail: SignFail.BadKind };
  const item = itemIdSafe(world, d.item); if (item === undefined || countItem(world, e, item) < 1) return { fail: SignFail.NoItem };
  if (!hasPrivilege(world, e, x, y)) return { fail: SignFail.NoPrivilege };
  removeItem(world, e, item, 1); emit(world, XpActivity, { entity: e, source: "sign", units: 1 });
  return { fail: SignFail.None, sign: spawnSign(world, kind, x, y, rot, pid(world, e), clanOfActor(world, e), text) };
}
export function setSignText(world: World, e: Entity, sign: Entity, text: string): SignFail {
  if (!world.isAlive(sign) || !world.has(sign, Sign)) return SignFail.NotFound;
  if (!canEditSign(world, e, sign)) return SignFail.NotOwner;
  writeText(world, sign, sanitizeSignText(text, signDef(world.getField(sign, Sign, "kind") ?? 0)?.maxLen)); return SignFail.None;
}
/** Pick up (refunds the item). */
export function removeSign(world: World, e: Entity, sign: Entity): SignFail {
  if (!world.isAlive(sign) || !world.has(sign, Sign)) return SignFail.NotFound;
  if (!canEditSign(world, e, sign)) return SignFail.NotOwner;
  const d = signDef(world.getField(sign, Sign, "kind") ?? 0); const item = d ? itemIdSafe(world, d.item) : undefined;
  if (item !== undefined) refundOrDrop(world, e, [{ item, count: 1 }]); // ADR-516: a full pack drops it in a bag
  world.destroy(sign); return SignFail.None;
}

export const PlaceSignCmd = defineCommand("gameplay.placeSign", { kind: "u8", x: "f32", y: "f32", rot: "u8" });
export const SetSignTextCmd = defineCommand("gameplay.setSignText", { sign: "u32", len: "u8", text: { type: "u8", length: SIGN_TEXT_MAX } });
export const RemoveSignCmd = defineCommand("gameplay.removeSign", { sign: "u32" });
export const SIGN_COMMANDS: readonly CommandDef[] = [PlaceSignCmd, SetSignTextCmd, RemoveSignCmd];
export const SIGN_ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = { [SetSignTextCmd.name]: ["sign"], [RemoveSignCmd.name]: ["sign"] };
const REACH = 6;
const tooFar = (world: World, e: Entity, x: number, y: number): boolean => { const t = world.get(e, Transform); return !t || Math.hypot(t.x - x, t.y - y) > REACH; };
const decode = (len: number, b: ArrayLike<number>): string => Array.from({ length: Math.min(len, SIGN_TEXT_MAX) }, (_, i) => String.fromCharCode(b[i] ?? 32)).join("");
export function installSignCommands(world: World, handlers: CommandHandlers): void {
  const run = (f: SignFail): void => { if (f) throw new Error(SIGN_FAIL_REASONS[f]); };
  handlers.on(PlaceSignCmd, {
    validate: (v, c) => (tooFar(world, c.actor, v.x, v.y) ? "too_far" : signDef(v.kind) ? undefined : "bad_kind"),
    handle: (v, c) => run(placeSign(world, c.actor, v.kind, v.x, v.y, v.rot).fail),
  });
  handlers.on(SetSignTextCmd, {
    validate: (v: { sign: number }, c) => { const s = v.sign as Entity; if (!world.isAlive(s) || !world.has(s, Sign)) return "not_found"; const t = world.get(s, Transform)!; return tooFar(world, c.actor, t.x, t.y) ? "too_far" : canEditSign(world, c.actor, s) ? undefined : "not_owner"; },
    handle: (v: { sign: number; len: number; text: ArrayLike<number> }, c) => run(setSignText(world, c.actor, v.sign as Entity, decode(v.len, v.text))),
  });
  handlers.on(RemoveSignCmd, {
    validate: (v: { sign: number }, c) => { const s = v.sign as Entity; if (!world.isAlive(s) || !world.has(s, Sign)) return "not_found"; return canEditSign(world, c.actor, s) ? undefined : "not_owner"; },
    handle: (v: { sign: number }, c) => run(removeSign(world, c.actor, v.sign as Entity)),
  });
}
