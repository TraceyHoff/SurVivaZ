# SurVivaZ

_A cozy survival game built on the 2.5D Survival Engine._

A cute, cartoony **2.5D isometric multiplayer co-op survival game** and its custom engine. It is browser-first and written in **TypeScript + WebGL2**. You gather resources, build bases, craft, tame pets, recruit AI helpers, farm, trade with other players and survive cold, rain, hunger, disease and the night, alone or with your clan. An authoritative Node server runs the same headless simulation as the browser client. The client predicts locally and interpolates everyone else.

> **Status:** playable and live — [play in your browser](https://traceyhoff.github.io/SurVivaZ/) (menu `vb320c3b5`). Most gameplay systems are implemented, tested and wired into the client: building, crafting, pets, farming, AI helpers, diseases, seasons, dyes and more. See [What's playable today](#whats-playable-today).

## Prerequisites

- **Node.js 20** (`.nvmrc` pins 20; 22 also works)
- **pnpm 10** via corepack: `corepack enable` (the version comes from `packageManager` in `package.json`)
- `better-sqlite3` ships prebuilt binaries for Node 20/22 on Linux, macOS and Windows x64/arm64. On other platforms it builds from source, which needs Python 3 and a C++ toolchain. `pnpm demo` rebuilds it automatically if the binding is missing.

## Quick start

```sh
git clone https://github.com/TraceyHoff/SurVivaZ.git
cd SurVivaZ
corepack enable
pnpm install --frozen-lockfile
pnpm demo
```

`pnpm demo` starts the game server on `ws://localhost:7777` (save file `./saves/demo.db`) and the Vite client. Open:

**http://127.0.0.1:5173/?player=1&server=ws://localhost:7777**

Use `?player=2` in a second tab to play co-op with yourself.

| Command | What it does |
|---|---|
| `pnpm demo` | server + browser client (`--bots 5` adds 5 bot players, `--fresh` starts a new world) |
| `pnpm demo:bots` | **dev load test only**: fresh server + 20 bots, prints stats (sets `NET_DEV_BOTS=1` for both) |
| `pnpm test` | all Vitest suites |
| `pnpm test:net` | net, testkit and server/client multiplayer integration tests |
| `pnpm check` | `pnpm -r typecheck` + `vitest run` (what CI runs) |
| `pnpm build` | build every package; Vite production bundles for the client and the render demo |
| `pnpm bench` | net/persist benchmarks (`PERF=1`) |
| `pnpm --filter @engine/render dev` | offline renderer showcase with the real art (lighting, weather, day/night, fire) |

Renderer demo URL params include `?time=0..24`, `weather=clear|rain|storm|snow|fog`, `cam=fire`, `gallery=1` and `inside=1`. See [packages/render/README.md](packages/render/README.md).

## Play in your browser

**https://traceyhoff.github.io/SurVivaZ/**

The GitHub Pages build is static, so it runs in **local/offline mode**: the authoritative server game module
(`apps/server/src/game.ts`, the same code `pnpm demo` runs) is hosted in the page over `@engine/net`'s in-memory
loopback transport, with IndexedDB persistence (memory fallback) and 3 local AI bots (`?bots=N` to change).
Limits: single-player plus local bots only, and your world is saved per browser. Real multiplayer needs
`pnpm demo` or a hosted server: open the page with `?server=wss://your-host` to connect to one instead.
Locally, `?offline=1` on the Vite dev client forces offline mode.

### Singleplayer vs multiplayer
- Offline/Pages (`createLocalServer`) is **singleplayer**. Zombies, animals and human bots (virtual players driven by the AI framework, see docs/AI_AGENTS.md) spawn on their own; no commands needed.
- `pnpm demo` / the Node server is **multiplayer** by default (`--mode singleplayer` or `GAME_MODE=singleplayer` to override). Human bots are completely disabled there, and `?bots` is ignored.

## Controls

**In the playable client today:** `WASD` move, `Shift` sprint, `E` gather / interact, `K` character sheet. Reloading the tab reconnects you as the same player.

**Renderer demo:** drag or WASD to pan, wheel to zoom, arrow keys move the player, `F` follow, `H` hide the UI.

**Full default bindings** (`@engine/input`, engine-level; see [ARCHITECTURE §18](docs/ARCHITECTURE.md)):

| Action | Keyboard & mouse | Gamepad | Touch |
|---|---|---|---|
| Move | WASD / arrows | left stick | virtual stick |
| Sprint | Left Shift | L3 | sprint toggle |
| Attack / use | Left mouse | RT | attack button |
| Charge attack | hold Left mouse | hold RT | hold attack |
| Secondary | Right mouse | LT | secondary button |
| Crouch | Left Ctrl | R3 | crouch toggle |
| Interact / radial menu | `E` tap / hold | X tap / hold | context button tap / hold |
| Jump | Space | A | jump button |
| Reload | `R` | Y | reload button |
| Hotbar | `1`–`6` | D-pad (+LB) | hotbar slots |

## Features

✅ = in the playable client today · 🔧 = implemented and tested in the engine/server, not yet exposed in client UI

### Engine core
- ✅ **ECS:** sparse-set entity-component-system with binary-serializable schemas, change tracking, seeded RNG, events and staggered slow systems
- ✅ **Fixed-tick loop:** deterministic 20 Hz simulation shared by server and client, with render interpolation between ticks
- ✅ **Chunk streaming:** a chunked, effectively unbounded isometric tile world (64×32 tiles, height levels) that streams chunks around players
- ✅ **Interest management:** AOI grid, so each client only receives the entities near it
- 🔧 **Transactions, scheduler, job queues, permissions, groups and claims** primitives in core

### Netcode & persistence
- ✅ **Authoritative server** over WebSocket, with snapshot deltas, **client-side prediction and reconciliation**, entity interpolation, lag compensation and basic anti-cheat
- ✅ **Persistence:** SQLite on the server (world chunks, building data, players, claims) and IndexedDB/memory in the browser. Worlds and players survive restarts, and reconnects use an account token.
- ✅ **Bots:** headless bot players (wander + gather) for load testing. 20 Hz holds with dozens of bots.
  Bots are a **dev load-test tool, never part of multiplayer**: `apps/server/src/bots.ts` refuses to start unless
  `NET_DEV_BOTS=1`, tags its connections (`demo.devBot`), and a multiplayer server (the Node default, `mode: "multiplayer"`)
  drops tagged connections unless it was also started with `NET_DEV_BOTS=1`. The production server path (main.ts / game.ts)
  never imports bots.ts. Human bots exist only in singleplayer/offline (the browser's local mode, `mode: "singleplayer"`).

### Survival gameplay (`packages/gameplay`)
- ✅ **Vitals:** hunger, thirst, stamina (drain, delay, regen), health, death; damage from starvation, dehydration, hypothermia and hyperthermia. Death clears diseases, infections and wetness.
- ✅ **Seasons & temperature:** summer 70–88°F, fall 36–69°F, winter 0–35°F; heat waves 89–100°F; snow below 32°F. Body temperature, **wetness** (rain and standing water wet you; wet clothing loses half its insulation), heat sources and shelter/enclosure detection. Enclosed rooms clamp felt temperature; fires warm rooms (campfires, fireplaces, wood stoves, furnaces, torch stands). Outdoor cold damage at 0–10°F is blocked by worn insulation ≥ 10.
- ✅ **Diseases:** data-driven (food poisoning, dysentery, wound infection, cold, heatstroke, exhaustion, influenza). Close-contact transmission, cloth masks block it, Honey Tea cures cold/flu, and a 4-minute care cure (dry, fed, hydrated, warm) clears cold/flu.
- ✅ **Farming:** hoe tilled soil, plant seeds, water and fertilize; 40 plantable crops (wheat, corn, vegetables, herbs, berries, fruit trees, hay, lettuce, pepper, beetroot, rice). Crops go dormant late fall / all winter and die below 40°F outdoors. Seeds come only from gathering each crop's own wild plant.
- ✅ **Pets:** 17 species (5 dogs, 3 cats, parrot, crow, chicken, rabbit, ferret, fox, owl, turtle, squirrel), each with its own skill tree (points at levels 1/6/11/16, cap 20). Tame with favourite treats — the hand-on-pet panel shows each species' favourites. Guard assignments, territory and fence containment.
- ✅ **Farm animals:** 11 species (chicken, duck, goose, turkey, cow, goat, sheep, pig, alpaca, bee, angora rabbit) producing eggs, milk, wool, truffles and honey into troughs. Bees deposit honey into a built **Apiary** instead (trough fallback; honey is never lost if both are full). Animals graze grass tiles and eat hay from troughs.
- ✅ **AI humans:** recruitable helpers. Each wants one fixed item from a 35-item pool, taken automatically from your inventory when you hire them. Jobs: Gather, Farm, Defend, Craft, Maintain. They furnish and upgrade their homes, garden, tame livestock, fill troughs and refuel lit fires. A host toggle (`AI humans in multiplayer`, on by default) turns new spawns/hires off.
- ✅ **Food decay & storage:** 4-stage spoilage (fresh → stale → spoiling → rotten); salt storage slows it (salt barrel ×0.5, curing box ×0.33, cold store ×0.2); frozen food below 0°C holds its freshness. Salt comes from salt-flat deposits on sand near water.
- ✅ **Inventory & containers:** 24 slots (16 pack + 8 hotbar), stacking, durability, atomic transfers. Storage lives on building attachments, reachable within 2.5 tiles. Death bags last 30 minutes with a 60-second owner-only window (PvP); dropped loose items despawn in 3 minutes.
- ✅ **Crafting:** recipes, stations (fired stations must be lit), timed jobs, atomic exchange at completion. Craftable-first sorting, Recently Crafted / Recently Built sections, skill and unlock gating.
- ✅ **Building:** grid-based base building with foundations, walls, floors, roofs, doors, fences and furniture; placement rules, rotation, support/stability (upper decks must be wall-connected; corner pieces alone don't support a deck), HP tiers, upgrades, repair, demolition and door/container states. 158 paintable pieces via the **dye system** (craftable dyes, paint brush in the hotbar).
- ✅ **Structure fire:** burning pieces take damage, spread to flammable tiers (twig/wood) and get put out by rain (`data/fire.json`). Rendered with flames, embers and smoke.
- ✅ **Combat & zombies:** damage pipeline, zombie spawning and AI, hordes. Aggressive spawns (zombies, wolves) are kept out of a 20-tile safe radius around installed spawn points; hordes are exempt.
- ✅ **Character creator:** names are required (Roll button generates a fitting "First Last" name); hair, face and eyes only — new characters start bare and must craft clothing. The in-game Character panel (`K`) shows the character sheet (timers, wetness, insulation); wardrobe, dyes and unlocks live in a separate Wardrobe panel.
- ✅ **World map, markers & compass:** world map with player markers, server-authoritative map markers (party/clan visibility, owner-only removal), compass with idle-north settling, hotbar split from the pack.

### Social, PvP & economy
- 🔧 **Clans/groups** with roles; **land claims** (claim totems) and a permission system (ACLs, ownership, claims, zones)
- 🔧 **PvP & raiding:** raid rules via permission hooks; destroyed stalls spill their stock and till as loot bags
- 🔧 **Chat:** channels, rate limiting, mute lists, wire encoding
- 🔧 **Player-driven trade-stall economy:** no NPC vendors. Stalls come in four sizes (blanket, cart, booth, clan pavilion with up to 24 listings), with stock, a till, prices in any item (`coin` by convention), offline sales, a sales ledger, clan rank policies and atomic purchases. **Crafter names** (provenance) stay on crafted items through every trade, and items made by different crafters never stack.

### Input (`packages/input`)
- ✅ Unified **keyboard & mouse, gamepad and touch** input: bindings, contexts, rebinding, tap/hold/long-press, on-screen touch controls, gestures, focus navigation and device-aware prompts. Phone keyboard: text fields exit element fullscreen before focus so the on-screen keyboard opens cleanly; the game re-enters fullscreen when you enter the world. Portrait and landscape both work (no orientation lock).

### Renderer (`packages/render`)
- ✅ **WebGL2 isometric renderer** (Canvas2D fallback) with depth sorting, sprite batching, building occlusion/cutaway, dynamic **lighting and shadows**, bloom, a **day/night cycle** with color grading, **weather** (rain, storm, snow, fog, wind sway), **fire** and particle VFX, held items, and runtime atlas themes. **Auto** is the default graphics preset on fresh installs (Low / Medium / High / Ultra / Full still selectable), so the game adapts to the device; Full pins full-resolution rendering. Tree occlusion fades trees to 35% instead of hiding them.

### Art & audio packs (`assets/`)
- The **Cozy-Wild** cartoon art pack: characters, zombies, critters, equipment, items, resources, tiles, buildings and VFX (8-direction sprites, atlases, a palette, piece variants, damage stages) plus audio. Bee, owl and Apiary art is painted at runtime (`apps/client/src/task34-art.ts`, new pixels — no reused sheets).
- **`survival_fx`:** day/night grading, LUTs, sheen masks, render tuning and fire/weather effects
- **`pvp_clan`:** clan palettes, totems, banners, rarity colors, fonts and world-UI colors
- **`ui`:** UI atlas, fonts, input prompt icons ([UI_GUIDE](assets/ui/UI_GUIDE.md))
- **`stalls`:** trade-stall art
- `tools/`: the Python generators (`python3 assets/tools/build_all.py`) that rebuild the pack
- See [assets/INTEGRATION.md](assets/INTEGRATION.md) and [assets/STYLE_GUIDE.md](assets/STYLE_GUIDE.md). The engine loads the validated copy in `packages/assets/pack/`, and the render demo serves `assets/` at `/@art/` (override with `ART_DIR`).

## What's playable today

- **Playable now:** browser single-player and multiplayer (move, sprint, gather, build, craft, tame pets, farm, recruit AI helpers, dye gear, cook, trade via stalls, chat, clans/claims) with prediction and reconciliation; persistent worlds and players; world map + markers + compass; character creator with name roller; seasons, weather, diseases and temperature survival; the WebGL2 renderer with real art, lighting, weather, day/night and fire.
- **Engine-only so far:** some clan/claim/trade UI polish, `@engine/input` gamepad/touch in the client, and WebTransport.
- **Planned:** WebTransport, cross-platform shells, a full art pass. **Done recently:** shovel terrain editing (±25), flowing water and underground bases (Task 36 / ADR-263); seeded world generation with varied heights and visible ledges (Task 35 / ADR-254).

## Current build status

As of the latest push (Task 34 + CI fix, remote `b320c3b5`, menu `vb320c3b5`): **CI ✅ · GitHub Pages ✅ · live.**

- `pnpm install --frozen-lockfile` ✅
- `vitest run` ✅ **2,743 passed / 1 failed / 3 skipped** (client 575/575, server 107/107, render 441/441, gameplay 1,106/1,109). The 1 failure is pre-existing: `pack.test.ts` reads `assets/building/KEYS.md`, which is absent from a sparse checkout but present in CI's full checkout.
- `pnpm -r typecheck` ✅ with the lockfile-pinned **TypeScript 5.9.3** (CI). Note: the dev VM's local `tsc` is 5.6.3 and can miss errors CI catches — always verify typechecks with the pinned version.
- Busy-world sim runs ~1.5 ms/tick with a base (Task 29 profile harness, `PERF=1`).

## Recent work

Work lands in gated batches: each batch starts only after the previous batch's CI **and** Pages are both green (checked at job level), and nothing is pushed until its tests pass and the user approves the push.

- **Tasks 1–21:** full-resolution rendering, crisp atlases, chests, heat waves, wall-connected ceilings, version marker, seamless rotation, hotbar/map/compass, diseases, pet guarding, animal skill trees, keyboard/orientation fixes, shore/tree fixes.
- **Task 22:** recruitable AI humans. **Task 23:** seasons, character sheet. **Task 24:** flame-heated rooms, cold damage. **Task 25:** dye system, custom icons, 3-minute despawn. **Task 26:** black-pixel hair fix, Full as default preset. **Task 27:** random name generator. **Task 28:** bot homesteading, salt storage, hay and grazing. **Task 29:** performance sweep (−46% sim time). **Task 30:** fur armor, frozen food, wall/door fixes, bot fire refuelling. **Task 31:** wetness, cold/flu, care cure, Wardrobe panel. **Task 32:** fox/owl/turtle/squirrel pets, 4 crops, pig/alpaca/bee/rabbit farm animals. **Task 33:** craftable-first crafting, death clears afflictions, safe spawn radius, disease rebalance, Recently Crafted. **Task 34:** unique bee/owl art, pet favourite treats, buildable Apiary (bees deposit honey; never lost when full).
- **Task 36 (done, ADR-263):** shovel terrain editing (±25 levels; Y / H, LT + D-pad ↑/↓, ⬆ Raise / ⬇ Dig buttons), water flowing through dug channels, underground bases (dark until lit, 60°F below 3 levels, crops grow with light + water). Task 35 (seeded worldgen / heights / ledges) is done (ADR-254); ADR-255 adds guaranteed lakes/rivers/ponds and full plant/resource coverage per seed; ADR-257 reserved unique wild lettuce / wheat / hay sprite keys; packed nature-pack art now ships under those keys (plus dedicated growth stages and icons).

## New creatures, items & art — status for the art pass

This is the inventory for the art/assets bot: everything new that still needs dedicated artwork, sprites or animations, and what it currently borrows. **How to read it:** *dedicated* = unique art already ships; *reuses X* = the animal/item is drawn as an existing sheet with a tint/scale (see `packages/gameplay/data/sprite_fallbacks.json` — real art in the pack takes over from a fallback automatically, so shipping a real sprite for a key fixes it everywhere); *generic icon* = the HUD/inventory icon falls back to a category icon. **How new art ships:** dedicated pack sprites go through the pack pipeline (`src/build.py` + regenerate `packages/assets/pack/ids.lock.json` with `write-lock-pack.ts`); the snapshot push route carries text only, so binary PNGs can never be pushed directly — embed as base64 data URIs in a `.ts` file (Task 25 pattern) or paint at runtime in code (Task 34 pattern, `apps/client/src/task34-art.ts`).

### Creatures with dedicated art already (do not redo unless improving)
- **Bee** (`animal_bee`) and **owl** (`animal_owl`) — unique runtime-painted pixels, idle + walk, 8 directions × 4 frames (`apps/client/src/task34-art.ts`; keys `pets_bee`, `pets_owl`). Verified numerically, not yet eyeballed live — the user is the judge of "beautiful".
- **Apiary** (`decor_apiary`) — unique runtime-painted stacked-hive art, 2 rotations × 4 damage stages. Its build-menu icon (`build_apiary`) is a dedicated stacked-hive tile on `items_build` frame 286 (no longer shares the salt barrel's frame 224).
- **Pig** (`animal_pig`) — shipped: dedicated `nature_critters_c_*` sheets (idle / walk / run / attack / hit / death / swim, 8 directions). Round pink farm pig with a disk snout; not a tinted boar (the boar keeps tusks and bristles).
- **Alpaca** (`animal_alpaca`) — shipped: dedicated `nature_critters_c_*` sheets (same animation set, 8 directions). Tall cream long-neck woolly camelid; not a tinted deer (the deer keeps antlers).
- **Turtle** (`animal_turtle`) — shipped: dedicated `nature_critters_c_*` sheets (same animation set, 8 directions). Sage dome shell with scute plates, stubby legs, and a yellow beak; not a tinted green boar. The death pose flips onto a yellow plastron.
- Other roster animals already ship unique packed sheets (not tinted copies): fox, squirrel, bear, bison, cow, deer / red deer / stag / elk / moose, duck, goat, goose, hare, sheep, snake, turkey, wolf, plus the original 13 pets (5 dogs, 3 cats, parrot, crow, chicken, rabbit, ferret) and the chicken farm animal. Wild `beehive` is a stacked hive on `items_nodes`, distinct from `tree_stump`. Fallback tints in `sprite_fallbacks.json` apply only if a pack key is missing.

### Creatures still reusing other animals' sheets (need dedicated sprites + animations)
None remaining — every animal key resolves to its own packed sprite when the pack is present.

### Crops & plants (need dedicated sprites + growth stages)
- **Lettuce** (Task 32) — shipped: unique `wild_lettuce` (idle + depleted), `crop_lettuce_0`–`crop_lettuce_3`, `crop_lettuce`, and dedicated `lettuce` / `lettuce_seeds` icons on `nature_icons`. Loose-leaf ruffled lime head, not cabbage's tight concentric rings (cabbage keeps frames 68 / 15). Replaces the ADR-257 runtime-painted `crops_task256` placeholder under the same keys.
- **Wheat** — confirmed unique: `crop_wheat_0`–`_3`, `crop_wheat`, `wild_wheat` (idle + depleted), plus sheaf / seed-bag icons on frames 64 / 8. Hay and rice no longer share those icon frames.
- **Hay** (Task 28) — shipped: unique `wild_hay` (idle + depleted), `crop_hay_0`–`crop_hay_3`, `crop_hay` (tall forage grass with no wheat ears), a tied hay-bale produce icon, and a hay-seed bag. Does not reuse wheat sheaf art. Replaces the ADR-257 runtime-painted placeholder under the same keys.
- **Pepper** (Task 32) — shipped: unique `wild_pepper` (idle + depleted), `crop_pepper_0`–`crop_pepper_3`, `crop_pepper`, and dedicated `pepper` / `pepper_seeds` icons. Compact chili bush with hanging tapered peppers, not tomato's staked round fruit (tomato keeps frames 65 / 11).
- **Beetroot** (Task 32) — shipped: unique `wild_beetroot` (idle + depleted), `crop_beetroot_0`–`crop_beetroot_3`, `crop_beetroot`, and dedicated `beetroot` / `beetroot_seeds` icons. Purple round bulbs with broad veined greens, not onion's yellow teardrop (onion keeps frames 69 / 16) or carrot's feather tops.
- **Rice** (Task 32) — shipped: unique `wild_rice` (idle + depleted), `crop_rice_0`–`crop_rice_3`, `crop_rice`, plus the already-dedicated produce / seed icons. Drooping grain panicles, not wheat's upright ears or flax flowers.
- Other older crops still share the same fallback pattern when pack art is missing — seed icons fall back to `wild_grain`, produce icons to generic fruit/vegetable art (see `sprite_fallbacks.json` `icons`).
- **Grazed bare grass** — dedicated short, eaten-down grass tiles ship as `gt_grass_grazed`, `gt_grass_grazed_fall`, `gt_grass_grazed_winter`, and `gt_grass_grazed_spring` (resident atlas `gt_grazed`, 4 columns). Visibly distinct from ungrazed `gt_grass` (shorter stubs, soil showing, no flowers). **ADR-256:** the engine draws these when a `GrazedTile` is present (WebGL + Canvas2D). See grazing logic in `packages/gameplay/src/skills/husbandry.ts` (about 180s regrow).
- **Spring ground tiles** — unique spring twins of every seasonal ground tile ship on resident pages `gt_spring_p0..p2` (`*_spring` keys: 6 variants per material, e.g. `gt_grass_c_spring`, `gt_rock_spring`; blob-47 edges `gt_<inv>_edge_<m>_spring`; `gt_shore_<m>_spring` / `gt_bank_<m>_spring`; `gt_side_<mat>_spring` / `gt_side_<mat>_low_spring`; 4-frame thaw water `gt_water_spring` / `gt_water_shallow_spring`). Own palettes (lime new growth, sparse blossoms, damp thawing soil, silty meltwater) — not recoloured summer/fall/winter art. Built by `packages/assets/pack/nature/src/artpass_spring_ground.py` (writes only spring pages; never rerun `ground_pack.py` main for this). Spring leaf-out/blossom twins now ship for `tree`, `tree_apple`, `tree_pine`, `oak_tree`, `bush`, `berry_bush`, `fiber_grass`, and `flowers` on streamed `season_tall_spring`, `season_res_spring`, and `season_huge_spring` pages. The 51 `road_<path|gravel|paved>[_mN]_spring` sprites ship on `season_roads_spring` with fresh lime verges, damp cel surfaces, and wrapped pink/cream/yellow petals. Source silhouettes, anchors, animations, sway and road alpha/autotiles are preserved; foliage has newly painted lime ramps, blossoms and new-growth tips, not finished-art hue shifts. Targeted rerunnable passes: `artpass_spring_foliage.py` and `artpass_spring_roads.py` in the same source directory (encode only their own new pages; leave other seasons untouched).

### Building pieces (need dedicated sprites)
- **Salt barrel** (tier 1, wood), **curing box** (tier 2, stone), **cold store** (tier 3, metal) — Task 28 salt storage. All three share atlas cells with other storage (`barrel_storage` / `storage_box` / `large_chest`); each needs its own sprite.
- **Apiary build-menu icon** — shipped: `build_apiary` now uses a dedicated stacked-hive icon on `items_build` frame 286. Frame 224 (salt barrel / barrel storage) is unchanged. In-world `decor_apiary` runtime art was left alone.
- **Salt-flat deposits** (Task 28, salt source on sand near water) — no dedicated deposit art listed; check `salt_flat` in the pieces data.

### New items & icons (need dedicated icons)
- **Task 32 items (ids 478–489):** lettuce, lettuce_seeds, pepper, pepper_seeds, beetroot, beetroot_seeds, rice, and rice_seeds now have dedicated nature_icons (lettuce no longer shares cabbage; pepper no longer shares tomato; beetroot no longer shares onion; rice no longer shares wheat). Salad, rice_bowl, truffle, and truffle_stew now have unique nature_icons (leafy green bowl, not fruit_salad; white rice with chopsticks, not baked_beans; lumpy dark fungus on frame 110, not mushroom on items/8; dark earthy stew, not vegetable_stew). honey, honey_cake, salt, and salted_fish already had dedicated icons — the older "generic berries fallback" note was stale. honey_tea (amber teacup) and salt_brew (pale saline bottle) now also ship unique icons. **Task 32 resources (ids 87–94):** the 8 new resources behind these items; lettuce, hay, pepper, beetroot, and rice world sprites now ship in the nature pack.
- **Tools and survival craftables:** paint_brush, charcoal_tonic, cooling_brew, medicated_bandage, cloth_mask, and waterskin now have dedicated nature_icons (paint_brush no longer falls back to the stone axe). The four boiled-water containers (boiled_water_flask, boiled_canteen, boiled_water_bottle, boiled_waterskin) also ship unique steamed versions of their vessels, so they no longer fall back to generic food art. All 24 tools and the survival foods/medicals checked in this pass use unique frames. `spear` / `club` are held-equipment aliases of `stone_spear` / `wooden_club` (same object, not two items).
- **Task 25's 39 custom HUD/menu icons** (`apps/client/src/game-icons-data.ts`, embedded as base64 data URIs) already ship as custom pixel art — do not redo unless improving. The 🔒 lock badges, tutorial text emoji and the `menu.ts` 🌡 label are still emoji and could use real icons.
- **Seeds in general:** every crop's seed icon falls back to `wild_grain`; every sapling icon falls back to `sticks` (except pine → `icon_pine_sapling`). Dedicated seed/sapling icons would fix dozens of items at once.
- **Meats:** raw/cooked venison, poultry, small game and prime cut already have dedicated nature_icons; milk, wool, and maple_syrup also ship unique icons. Fallback tints in `sprite_fallbacks.json` apply only if a pack key is missing.

## Repository layout

| Path | Contents |
|---|---|
| `packages/core` | ECS, schemas + binary codec, fixed-step loop, RNG, events, permissions, groups, transactions, scheduler, chat model |
| `packages/world` | chunks, iso coordinates, chunk streaming, interest grid, spatial index, building grid, emitters/climate, chunk codec |
| `packages/net` | transport, protocol, snapshot deltas, prediction, lag compensation |
| `packages/persist` | world/player persistence (SQLite, IndexedDB, memory) |
| `packages/gameplay` | survival rules, crafting, building, combat, inventory, fire, economy (`data/*.json` defs) |
| `packages/input` | unified KB+M / gamepad / touch input |
| `packages/render` | WebGL2 isometric renderer + visual demo (`shots/` has screenshots) |
| `packages/assets` | manifest schema/loader/validation, stable ids, recipes; `pack/` is the engine copy of the art pack |
| `packages/testkit` | headless helpers + multi-client loopback harness |
| `apps/server` | headless authoritative server, bots |
| `apps/client` | Vite browser client |
| `assets/` | source art & audio packs (sprites, atlases, audio, survival_fx, pvp_clan, ui, stalls, tools) |
| `scripts/demo.mjs` | `pnpm demo` / `demo:bots` orchestration |
| `docs/` | architecture and decision records |

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): ECS, loop, serialization, world streaming, interest management, building grid, asset pipeline, environment, social/combat/crafting, persistence, input, economy
- [docs/DECISIONS.md](docs/DECISIONS.md): ADR log
- [packages/net/ARCHITECTURE.md](packages/net/ARCHITECTURE.md): netcode
- [packages/persist/README.md](packages/persist/README.md): persistence
- [packages/gameplay/DESIGN.md](packages/gameplay/DESIGN.md) · [README](packages/gameplay/README.md): survival game design
- [packages/render/README.md](packages/render/README.md): renderer
- [packages/input/README.md](packages/input/README.md): input
- [assets/INTEGRATION.md](assets/INTEGRATION.md) · [assets/README.md](assets/README.md): art pack

---

## Handoff note for Muse (Muse.ai) and Grok — read this first (updated 2026-11-13, ~16:40 CST)

Welcome back. You handed off at remote `main` **`ef8b91f0`** (Guide icons batch, ADR-387 was the last ADR), and CI and Pages are green on it (checked 2026-11-13 ~16:38 CST). Since the last note (remote `e0d7519`, ADR-364, written 2026-11-12), Muse did the work in **ADR-365 through ADR-387** — note the renumber: the performance batch the old note called ADR-365–367 shipped as **ADR-368–370**. Everything below is pushed, CI + Pages green, and live on https://traceyhoff.github.io/SurVivaZ/ unless noted. Pick up from here.

### State in brief
- **Stack:** TypeScript pnpm monorepo. The packages are `core` (ECS), `world`, `net`, `persist`, `gameplay` (rules plus `data/*.json`), `input`, `render` (WebGL2), `assets`, `testkit`, `apps/server` (authoritative), `apps/client` (Vite; singleplayer hosts the server in-process, with AI humans as virtual players in `apps/client/src/local.ts`). The repository layout table above is still accurate.
- **Commands:** `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm check` (typecheck + every Vitest suite), `pnpm -r build`.
- **CI:** `.github/workflows/ci.yml` runs install, `pnpm check` and `pnpm -r build`. `pages.yml` deploys https://traceyhoff.github.io/SurVivaZ/.
- **Dist size (ADR-391–395, 2026-11-13 ~19:00 CST):** the built client went from 963.8 MB to 732.6 MB, all lossless. The build ships only the art the client resolves (`apps/client/art-build.ts` `planArt`): a new file in an `atlases/` dir ships only if a manifest names it or client code names it literally. KTX2 twins of always-resident atlases are stripped. Identical tint masks are shared. PNGs go through pinned oxipng 9.1.5 (cache in `.cache/oxipng`, `SURVIVAZ_OXIPNG=off` to skip locally). Manifests ship as `.json.gz`. CI and Pages run `node scripts/check-dist-size.mjs` (800 MB budget) and `apps/client/test/adr395_dist.test.ts` on the built dist.
- **Icons and roofs (ADR-396–397, 2026-11-13):** HUD icons (season, thermometer, vitals fallback) resolve through `iconUrl` (embedded data URIs). `adr396_icon_paths` fails on any hand-built `icons/` URL and, in the CI and Pages dist step, on any requested icon missing from dist. There is no dedicated spring icon yet; spring shows `ic_sun`. Continuous roofs (Art's `rfx_*` scheme, `docs/ART_KEYS_ROOFS.md` §4 in the art pass): `packages/assets/src/roofRfx.ts` picks per level, `apps/client/src/roof-tiler.ts` caches them, and `SpriteBindings.pieceRoofFx` draws the lift and overlays. Legacy roofs draw unchanged until the rfx pages land.
- **Last gate (ef8b91f0, Guide icons batch, ADR-387):** 4,347 passed, 1 failed (known persist autosave bench flake, 60.63 vs 50 — passes standalone with `PERF=1`), 5 skipped. New tests 23/23; typecheck clean with pinned TS 5.9.3. Canaries 24/24 (adr203 3/3, adr252-live 8/8, adr331 8/8, adr385 5/5).
- **Pushing:** Grok pushes plain git fast-forwards: `git push origin <sha>:main` (never force-push, never reset). **Muse in this VM has no git-push credentials, so Muse pushes through the `push-files` snapshot route instead** (`github push-files --owner TraceyHoff --repo SurVivaZ --branch main ... --paths-file <paths file>`). The snapshot route is **text-only: binary files cannot ship through it**, so any new art must be painted at runtime (see ADR-357/361/364). A push approval card appears and **expires in ~30 min if untapped** — flag it promptly; chat approval alone does not push. The no-chat-confirmation push rule covered only the travel batch and ADR-347–350; every later batch needs the user's explicit push go-ahead in chat plus the card tap.
- **Stale sections:** the "Status", "Current build status" and "What's playable today" sections above still describe `b320c3b5` and need a refresh.

### Where decisions live
- [docs/DECISIONS.md](docs/DECISIONS.md): one ADR per change. Each one covers context, decision, knobs and tests.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [packages/gameplay/DESIGN.md](packages/gameplay/DESIGN.md)
- [docs/AI_AGENTS.md](docs/AI_AGENTS.md) (AI humans)
- Tuning knobs are in `packages/gameplay/data/*.json`. New since you left: `mounts.json` (including `"bots"`), `travel.json` and `ai_spawn.json`.

### What changed since `b320c3b5`
Built from `git log` and DECISIONS.md headings. Short SHAs are the implementing commits.
- **World and terrain**
  - Seeded worldgen, varied heights and visible ledges: ADR-254 `35210c48`
  - Lakes, rivers and ponds on every seed: ADR-255 `98d53984`
  - Shovel terrain editing, flowing water and underground bases: ADR-263 `d617f77b`
  - Soil conservation: ADR-264 `032547b2`
  - Terrain ladder, finite AI earthworks, complete-frame camera crossfade and build hologram cell: ADR-265–268 `09813745` (hardening in `af8f0bfc`)
  - Relief previews and a larger streamed wilderness: ADR-272 `762e01ba`
  - Camera-aware drop-off relief: ADR-276 `dc5118aa`
  - 4× world domain and terrain range −60…+75: ADR-296/297 `f912fe4a`
  - Shaft Hatch: ADR-299 `35e3d2af`
  - Seeded abandoned structures with loot and stations: ADR-300 `cc9bc9c6`, ADR-301 `a16ba8a1`
  - Varied roofs on abandoned buildings: ADR-311 `4e011a77`
- **Seasons, climate and time**
  - Spring season: ADR-260 `b9dfe3e2`
  - 15-day seasons: ADR-261 `fdfde647`
  - °F/°C everywhere, seasonal daylight and AM/PM clock: ADR-282–284 `7e87f66c`
  - Player-tuned sunrise/sunset: ADR-285 `b1d2f0d6`
- **Survival and health**
  - Torch boils water and cooks meat: ADR-262 `f3dbdfcf`
  - Fewer infections, a dry first day, held-tool grips and choosing the seed first: ADR-270 `361d5e6f`
  - Three-tile climbing and fall damage: ADR-271 `a3a28578`
  - Speed bump, Broken Leg and Leg Splint: ADR-274 `829503a1`
  - Staged body temperature, wetness and infection: ADR-277–281 `3eb09515`
  - Partial shelter with a HUD icon: ADR-312 `9bd83f24`
- **Farming**
  - Unique wild lettuce, wheat and hay: ADR-256/257 `233f1094`, `4a067cf5`
  - Plants need water and light: ADR-286 `e43fdde8`
  - Growth, hydration and fertilizer bars: ADR-287 `5ea10433`
- **Building and claims**
  - Furniture section: ADR-288 `f121d321`
  - Clearer demolish targets and the Claim Flag in Hand Crafted: ADR-302 `653a908a`
  - Doors open from Use, and no floating floors: ADR-303 `db8b4b82`
  - Claim Flag required before building, and skill-gated repairs: ADR-310 `b54c9710`. The Claim Flag costs 10 logs (`d28e41fb`). CI was restored in `a99b800d`.
  - Door swing art and sounds: ADR-314 `46b3493e` (art `0159d391`)
  - Bigger claims with a radius preview, a border toggle and no overlaps: ADR-315 `a60affc4`
  - Demolish without a hologram, touch select and confirm, builder refunds, claim permission gate, and moving placed pieces: ADR-316–318 `7b7e1454`
- **Camera, UI and controls**
  - Portrait HUD, host AI policy and safe hand input: ADR-258 `85e5392f`
  - Undressed AI spawns, cloth mask and character outline: ADR-269 `001f7428`
  - North follows the default view: ADR-273 `2167f6b1`
  - Contextual tips: ADR-275 `d311a97a`
  - Auto-sprint and direct hotbar taps: ADR-289 `c1c59652`
  - Liquid fill bar: ADR-290 `aaf9b673`
  - Visible Block, then dedicated block animations: ADR-291/298 `5fcf65cc`, `7e08bbc0`
  - North-up map, idle facing and sprint run-up: ADR-292–294 `766d4367`
  - Closer indoor zoom with wall cutaway: ADR-304 `166d5472`
  - Idle heading and colour-coded ledge warnings: ADR-305/306 `2e48ae16`
  - Asset cache and prefetch: ADR-307 `62154140`
  - Current story only: ADR-308 `bb111636`
  - Indoor zoom under missing ceilings: ADR-309 `af8dbcc7`
  - Earlier ledge warnings: ADR-313 `d8a309a7`
  - Crafting-menu icon fix and creator beard fix: `aca8340a`, `5351c72f`
- **Multiplayer:** friend-code guests spawn near the host: ADR-295 `4c180f57`
- **Mounts and saddles**
  - Tame, ride and gallop at true scale: ADR-319 `44565535`, `f890ab2d` (art `fafe447e`)
  - Four saddle tiers with saddlebags and Saddlery: ADR-320 `9421ff1b`
  - Seated rider poses, mount hit/death/graze/swim, and lazy ride pages: ADR-322 `b6801e42` (art `a775f75c`, `9281a1bd`, `22893a25`)
- **AI humans**
  - Detailed hired orders and survival-aware Follow: ADR-259 `a7f51e32`
  - Tame, ride and care for their own mounts: ADR-321 `42e1e4bf`
  - Mount food from own, employer or permitted clan storage (never others'), foraging otherwise, and saddle material planning with tier fallback and timeout: ADR-323 `63cf6398`
  - World-wide travel:
    - hierarchical region routes;
    - clan-stay vs roam preference;
    - riding on long legs;
    - a budgeted, deterministic off-screen sim.
    - ADR-324 `3cd8d41d`
  - Spawn and respawn over seeded world-wide points (least-populated, away from players; bed, then home, then a distributed point); far spawns start off-screen: ADR-325 `3fc34d8d`

### What changed since `3fc34d8d` (Muse, 2026-11-10 → 2026-11-12)
Built from `git log`, MEMORY.md and DECISIONS.md headings. Short SHAs are the implementing commits. Every batch below is pushed, CI + Pages green, and live on https://traceyhoff.github.io/SurVivaZ/ unless noted.
- **Open-items fix (ADR-326–331) `6755f978` (+ re-trigger `cc9bc9c6`):** spawn safety for the ADR-325 world-wide points; hired workers run the saddle chain (idle-only, at the employer's base); `gate_clan` door-swing last-frame pop (dynamic chunks kept alive); seeded route-water sampling for unloaded regions; `vehicle_net` flake bound 4 → 6 (test-only); coverage + a real bug fix (`aiRespawnPoint` returned undefined for every bot — `Worker` owner 0 is for-hire, not hired). Gate: 3,459 passed / 1 failed (pre-existing `pack.test.ts`) / 3 skipped; new/touched tests 73/73. Pages failed the deploy step twice with GitHub-side "Timeout reached, aborting!" (build succeeded both times — not a code failure); the re-trigger push went green. Lesson: `deploy-pages@v4` caps deploys at 10 min despite the workflow asking 30.
- **Image shrink (ADR-332–334) `4eef775`:** JSON minify, v2 sample excluded from dist, m4a-only audio — dist 988,942,726 → 898,304,130 bytes (−90.6 MB), no visual change. CI 42902018895 + Pages 42902018952 green. ADR-335 (dedupe) deferred. Still needed: Safari listen test for m4a-only audio; `?charArt=v2s` now 404s (accepted). Dist is still ~898 MB, close to Pages' 1 GB site limit.
- **AI-life batch, Task 37 (ADR-336–339) `c4d5a74`, plus follow-ups (ADR-340–342) `5300607c`:** AI humans with own lives/wants/aspirations/goals when not helping players; repair/rebuild/claim abandoned structures or claim + build an enclosed structure of their own design; tame a mount of their choice and keep it until it dies; defend claimed territory/resources/livestock with barbed wire and turrets; hired AI gather/craft their own saddle materials. Follow-ups: ruin homes get full base behaviour, defence in `makePlan`, turret ammo stocking (plus a planner→defence import-cycle fix — pure planning moved to leaf module `defence_plan.ts`). Gate: 3,694 passed / 2 failed / 3 skipped (known pre-existing); new tests 197/197.
- **Travel batch (ADR-343–346) `f235d48e`:** resource expeditions, distance-based journey prep, water navigation, regression fix. CI 42957591256 + Pages 42957591262 green.
- **Hologram / safe zones / world crops / damage pulse (ADR-347–350) `492b185`:** hologram shows only where placement is valid; safe zones around beds, AI homes and guest arrivals; fruit trees + crops visible in the world; damage pulse on composited DOM layers (48.6 ms → 0.003 ms mean). First push `499ca35` failed CI (TS2307 "Cannot find module @engine/gameplay") — ADR-347's gameplay test self-imported by package name; **lesson: a package must never self-import by package name, always use relative imports inside its own tests.** CI 43022760362 + Pages 43022760002 green.
- **Animal batch (ADR-351–354) `bff4921`:** rope leading; dung + longer fertilizer (dung fertilizes 900s vs 600s old, despawns after exactly 10s); wider diets + trough feeding; tameable animals calm (moose was the only tameable attacking on sight — now defensive). Gate: 3,991 passed / 2 failed (known pre-existing) / 3 skipped; new tests 66/66. Honest cuts: bots don't fetch rope or stock troughs with crops; crop inspector misreads dung-fertilized crops for 5 min (cosmetic); dung uses a generic loot sprite.
- **Storage batch (ADR-355–357) `5c303fc`:** resource-specific stores (ore/log/stick/crop/stone, 12 slots, WrongStorage BuildFail 34, AI stash/fetch wired); dedicated runtime-painted world art per store with empty/half/full fill states; runtime-painted menu icons (the shipped `items_build` frames 297–301 are blank — 0 opaque pixels vs 349 for Apiary 286 — so icons are painted at runtime from the world art). Gate: 4,016 passed / 2 failed (known pre-existing) / 3 skipped; new tests 24/24.
- **Wagon/vehicle batch (ADR-358–361) `5a48484`:** 9 vehicle defs (wagon small/medium/large ± covered, cart, carriage, chariot — chariot ~9.6 tiles/s behind a galloping horse, large wagon capped 5.0); Harness equipment (item 510, hook/detach, AI harness too); driver-seat riding (players/AI sit visibly in seat 0 in all 8 directions; the mount's own rider wins input precedence); runtime-painted vehicle + harness art, icons verified by pixel read. Gate: 4,100 passed / 2 failed (known pre-existing) / 3 skipped; new tests 77/77. Honest cuts: wheels don't animate (mid-roll spokes); wagon driver same seated pose moving/idle; hitching has no ownership check. First push attempt timed out on the snapshot route after approval (remote main verified still `5c303fc` — nothing landed); retry landed.
- **In-game guide batch (ADR-362–364) `e0d7519`:** detailed guide from the main menu and the in-game pause menu, covering all game systems (features, icons, diseases, temperature, cooking, building, AI humans, tamed/farmed animals, crops, …), in the existing UI/modal language, using existing icons/sprites/artwork plus tile-row action images. ADR-362 content/data, ADR-363 window, ADR-364 art (section icons + action images; tiles are spans, never `<img>`). Gate: 4,131 passed / 2 failed (known pre-existing) / 3 skipped; new tests 30/30. Honest cuts: the six action images are tile rows, not staged screenshots; the guide has no hotkey and is not on the menu bar (main menu or pause only).

### What changed since `e0d7519` (Muse, 2026-11-12 → 2026-11-13)
Built from `git log`, MEMORY.md and DECISIONS.md headings. Short SHAs are the implementing commits. Every batch below is pushed, CI + Pages green, and live on https://traceyhoff.github.io/SurVivaZ/ unless noted.
- **Performance batch (ADR-368–370) `9ecf1388`:** sim hot paths (spawn, pathfinding, zombie AI, expressions, spoilage, crops, husbandry, respawn), net replication (dirty-driven snapshots, wire stays v8), render warm-up (atlas page-in, 1,500 ms window, `?diag=1` breakdown). Gate found and fixed a regression: nearest-first chunk order starved far chunks and broke ADR-252 bots — reverted to FIFO. **After this push the game went laggy on the user's phone (Galaxy A16) in real play** — worst at boot and moving through new areas — while benches said the sim was flat and net ~20% faster. Trust her eyes over benches; the phone is the performance bar; never lower graphics quality to buy speed.
- **Ride / stairs / ruins (ADR-371–373) `07062533`:** ride passenger seats of wagons/carriages/carts while another drives (safe dismount, AI `ride_passenger`, passenger HUD chip); reachable second floors via outside or inside stairs (stair tiles are ramps; zombies do not route upstairs; broken stairs rebuildable); ruins 14 → 28 kinds. Gate: new tests 55/55, gameplay 2,070 passed.
- **Performance fixes (ADR-374–377, 379–381) `aec22804`:** warm-up pump (pending → 0); net replicate alloc cleanup (no measured speedup); captureState floor (~64% faster at 0% dirty); animalAI; chunk-load budget (plain-chunk over-2 ms updates 98% → 44% at boot drain); boot split in `?diag=1` (sprite tables O(S×A)→Maps, ~5.6–8.4× faster on the real manifest) and frame CPU (PhaseTimer `phases` line, cutaway cache, per-part static piece cache). ADR-378 was reverted (deterministically broke 4 AI-human tests). **The 28.5 s boot is NOT claimed fixed** — the split is the instrument. Gate: 4,268 passed, 1 known flake.
- **Stamping redesign (ADR-382) `0df222d3`:** time-sliced abandoned stamping (≤20 pieces/tick) + `goTo` always routes + boot drain. Root cause, proven by intervention: `goTo()` only used the pathfinder when `editIndex.size > 0`, so the first dig never routed. Site-tick median 3.90 → 2.10 ms. Gate: 4,279 passed, 1 known flake.
- **Elevated lakes + single-level ruins (ADR-383–384) `6d63c8d4`:** one elevated lake per 512-tile region (level 4–7, flow-water encoding, zero renderer changes); ruins strictly single-level (old rule allowed hi−lo ≤ 2). Gate fix: SITE_CHANCE 0.25 → 0.15 — 0.25 reshuffles site spawn points and broke adr331 — so density fell to ~6/100 chunks. Honest cut: ~32% of elevated lakes merged with the sea (raised plateau, not a separate mountain lake) — fixed by ADR-386. Gate: 4,304 passed, 1 known flake.
- **Planner fix (ADR-385) `28d1d778`:** bots re-target unreachable goals; the real freeze mechanism was `garden` (an unhired bot tending an unreachable berry bush), not `gather`. SITE_CHANCE restored to 0.25 — density back to ~10/100 chunks. Gate: 4,310 passed, 1 known flake; adr252-live 8/8 twice.
- **Waterfalls (ADR-386) `c30d9660`:** noise-aware lake siting (98.0% sited, 2.0% skipped, sea-touch 0) + real waterfalls — the only way an elevated lake connects to sea-level water (one 2-level drop, then −1/tile; swimmable both ways). Gate found one defect: length-1 spillways were a one-way fall-damage trap — gate fix makes them closed lakes. GLSL compiler-validated. Gate: 4,323 passed, 0 failed.
- **Guide icons (ADR-387) `ef8b91f0`:** Guide listings show their icons (64/133 rows; the broken-leg listing reuses the existing `broken_leg` status art); no sprint with a broken leg (gate in the shared `applyMovementInput` — walk × 0.5, no sprint stamina drain, sprint returns when healed); a runtime-painted book icon replaces the Guide emoji. On-foot sprint is auto-sprint only (ADR-289) — there is no sprint control to disable on any device. Gate: 4,347 passed, 1 known flake; canaries 24/24.
- **Crouch / waterfalls / container titles (ADR-388–390, Grok, 2026-11-13):** walking, sprinting and swimming now make zombie-audible noise (walk 12 / sprint 18 / swim 7, ×0.4 when crouched, players + AI humans + hired workers), crouch footsteps are quieter, and the doll plays Art's `crouch_idle` / `crouch_walk` (`5eb3c037`; lazy `cz_crouch_*` pages, walk/idle fallback while streaming); waterfalls draw Art's lip, 1- and 2-level sheets and impact pools (`e8c03108`, `097c8a71`) with the ADR-386 streaks as the no-art fallback; storage windows are titled with the container's name (Crate, Log Store, Death Bag, Saddlebag, …, ellipsis on narrow screens). Rebased on Art's commits; SHAs in DECISIONS.md / git log.

### Open items and untested areas
- **Phone tests outstanding (the real check — the user plays on her phone, Galaxy A16):** still untested on the live build: `?diag=1` boot split + phases line (`aec22804`), new-area hitch (`0df222d3`), elevated lakes + fewer ruins (`6d63c8d4`), ruin density + bots no longer freezing (`28d1d778`), waterfalls + mountain lakes (`c30d9660`), Guide icons + no sprint with a broken leg (`ef8b91f0`). The game has been laggy on her phone since `9ecf1388` — worst at boot and in new areas — and no bench reproduces it.
- **Queued:** junction-face fix (a sited lake's rim touching level-0 water is the same one-way-trap shape as the length-1 spillway; probe says re-siting 16/18 and skipping 2 would fix it) and the farm-sensor tend-target polish (tend targets don't consult the ban predicate — ADR-385 gate observation).
- **Still open from earlier:** an affordable saddle tier needs every station already at the base; Safari listen test for m4a-only audio (ADR-334); ADR-335 dedupe deferred.
- **Fixed 2026-11-10 (ADR-326–331, Muse):** the `vehicle_net` flake (bound 4 → 6, ADR-330 — the bound sat inside the model's own range); AI spawn safe zones (ADR-326 — the 20-tile radius now covers the ADR-325 world-wide points too); hired workers run the saddle chain (ADR-327); route water sampling reads seeded terrain for unloaded regions (ADR-329); the `gate_clan` door-swing last-frame pop (ADR-328 — dynamic pieces no longer wipe their chunk's fade-in clock); and test coverage for off-screen hand-back, bot restore, homestead relocation, long-trip riding and spread spawns (ADR-331 — which also fixed a real bug: `aiRespawnPoint` returned undefined for every bot because every AI human carries a `Worker` record with `owner: 0`; only a non-zero owner counts as hired now).
- **Not checked on real devices:** nothing was verified on a real phone or controller. The claim overlay and riding have not been seen on screen. Art and UI were checked by tests and numbers only. The gate_clan fix is verified numerically (alpha test) only — the user's eyes on the live build are the real check that the blink is gone.

### Working conventions (from the user)
- **Art:** unique, dedicated art only. No recolors or reused sprites, and never generate or fake art.
- **Input:** gamepad, keyboard and touch must all work for every feature.
- **UI:** minimal, with nothing overlapping. Use never opens the inventory, except for containers. Don't change the compass. Don't lower graphics quality. Keep play smooth.
- **Code:** reuse existing systems, and put tuning knobs in data JSON. Don't reopen finished ADRs except to extend them. Commit style: `feat(SurVivaZ): … (ADR-xxx)` with a DECISIONS.md entry.
- **Shipping:** fast-forward pushes to `main` only (Grok's route; Muse in this VM uses the `push-files` snapshot route instead — same rule: `main` only, never force-push), and CI must be green after every push. "Done" means implemented and tested.
- **Times:** report times in America/Chicago (CST).

### Where to pick up next
1. **Phone test first, then the queue.** The next free ADR number is **ADR-388**. Queued: the junction-face fix, then the farm-sensor tend-target polish (small batch). Wait for the user's phone verdict on the live build before starting the next batch.
2. Remaining candidates: refreshing the stale README status sections (still describing `b320c3b5`); an on-screen and device check of claims and riding (needs the user); the Safari m4a listen test; ADR-335 dedupe; an affordable saddle tier that doesn't need every station at the base.
3. **Standing lessons (do not re-learn these):** never self-import a package by package name in its own tests — relative imports only (ADR-347's `499ca35` CI failure); the snapshot push route is text-only, so new art must be painted at runtime, never shipped as binary (ADR-357/361/364); typecheck with the lockfile-pinned TypeScript 5.9.3, not the VM's 5.6.3; push approval cards expire in ~30 min; Muse in this VM pushes via the snapshot route (no plain-git credentials here); a passing test suite and a green deploy are not proof the game looks or feels right — new art is verified numerically, not visually, and the user's eyes on the live build are the real check. The user's phone play-test is the real check for performance too — bench numbers never prove smoothness. Times in America/Chicago (CST).
