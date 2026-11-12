// Updates pack/ids.lock.json for the real art pack (Cozy-Wild) + its sub-manifests (ui kit, branding, customization, vehicles, items). Keeps every existing id and appends new keys (never renumbers).
// Usage: tsx packages/assets/scripts/write-lock-pack.ts [manifestDir=packages/assets/pack]
// The first run seeds the lock from sample/ids.lock.json so ids shared with the placeholder sample stay identical.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadManifest, mergeManifests, type ManifestJson } from "../src/index.js";
import { readManifestJson } from "../src/node.js";
const here = new URL("../", import.meta.url).pathname;
const dir = (process.argv[2] ?? here + "pack").replace(/\/?$/, "/");
const lockPath = dir + "ids.lock.json";
const prev = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : JSON.parse(readFileSync(here + "sample/ids.lock.json", "utf8"));
// One lock for the merged runtime manifest: pack + the sub-manifests the client loads (apps/client/src/view.ts MANIFEST_INDEX).
const root = here + "../../";
const SUBS: [string, string][] = [["ui-kit", root + "assets/ui/kit/manifest.ui.kit.json"], ["branding", root + "assets/ui/branding/manifest.branding.json"], ["customization", dir + "customization/manifest.customization.json"], ["vehicles", dir + "vehicles/manifest.vehicles.json"], ["items", dir + "items/manifest.items.json"], ["vehicle_items", dir + "vehicle_items/manifest.vehicle_items.json"], ["building", dir + "building/manifest.building.json"], ["nature", dir + "nature/manifest.nature.json"],
  // Task 34: generated bee / owl / apiary fragment (layout only, no PNGs).
  ["task34", dir + "task34/manifest.task34.json"],
  ["task256", dir + "task256/manifest.task256.json"],
  // ADR-356: dedicated store fragment (layout only, no PNGs).
  ["task355", dir + "task355/manifest.task355.json"],
  // ADR-361: dedicated drawn-vehicle + harness fragment (layout only, no PNGs).
  ["task361", dir + "task361/manifest.task361.json"],
  // ADR-242: Art's top-level drops; they repeat building-pack keys (first wins), so only their collisions are tolerated
  ["pvp_clan", root + "assets/pvp_clan/manifest.fragment.json"], ["stalls", root + "assets/stalls/manifest.fragment.json"]];
const TOLERATED = new Set(["pvp_clan", "stalls"]);
const frags = [{ name: "pack", manifest: JSON.parse(readFileSync(dir + "manifest.json", "utf8")) as ManifestJson },
  ...SUBS.filter(([, f]) => existsSync(f)).map(([name, f]) => ({ name, manifest: readManifestJson(f) as ManifestJson }))];
const merged = mergeManifests(frags);
const bad = merged.collisions.filter((c) => !c.fragments.slice(1).every((f) => TOLERATED.has(f)));
if (bad.length) { console.error(`${bad.length} duplicate keys across sub-manifests`, bad.slice(0, 10)); process.exit(1); }
const { lock } = loadManifest(merged.manifest, { lock: prev });
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
console.log(`${lockPath} updated`);
