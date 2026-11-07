/**
 * Task 14: gameplay tips shown on both loading screens (boot + the second post-mode screen), rotating every
 * few seconds. Kept short and tied to systems players actually meet early.
 * Task 16: rotation slowed to 10 s so each tip is readable, and the text darkened one step (still legible
 * against the dark loading-screen gradient — see TIP_COLOR).
 */
/** Task 16: milliseconds between tip rotations on both loading screens (was 6000). */
export const TIP_ROTATION_MS = 10000;
/**
 * Task 16: tip text color (was #C9C2B8). A medium warm gray: visibly darker than before, but still
 * ≥ ~4.5:1 against the mid/dark zones of the loading gradient (#22301f → #14110f) where the tip sits,
 * so it stays readable. Going darker would drop below comfortable contrast on that dark background.
 */
export const TIP_COLOR = "#9C968C";
export const TIPS: readonly string[] = [
  "Raw meat and untreated water can make you sick — boil water at a lit campfire and cook meat before eating.",
  "A cloth mask (fiber ×6) blocks disease spread — wear one near sick players or AI humans.",
  "Pets can guard a spot, a building, a station, or a friend — open your pet's panel and pick Guard.",
  "Hunger drains slowly, thirst faster — keep cooked food and a filled waterskin on you.",
  "Roofs and upper floors need a wall below them somewhere in the same cluster, or they won't place.",
  "A fully enclosed, roofed room holds {temp:8}–{temp:32} — build shelter before the heat wave or the cold snap.",
  "Your pack holds 24 slots — stash spare gear in a chest at your base.",
  "Heat waves are rarer now but still deadly — stay indoors, drink, and rest through the worst of it.",
  "Press M for the world map — place markers for your base, water, and good loot, and share them with your party or clan.",
  "Offer a treat to a wild dog, cat, bird, rabbit or ferret — each species loves some treats and refuses others.",
  "Fence your livestock in and keep the gate shut — an open or broken gate lets them wander off.",
  "Sick? Charcoal Tonic, Salt Brew, Honey Tea, Cooling Brew and Medicated Bandages cure the matching disease — brew them at a campfire.",
  "Your pets and farm animals defend your claim when a zombie wanders in — even fenced animals fight back from behind the fence.",
] as const;
/** Next tip index, wrapping around (pure, so the rotation is testable without a timer). */
export const nextTip = (i: number): number => (i + 1) % TIPS.length;
