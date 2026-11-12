# Vehicles (engine foundation)

Owner: Engine. Survival owns recipes and station behaviour, Art owns sprites, Renderer draws, Netcode syncs.
Decision record: ADR-096 in DECISIONS.md. Code: `packages/gameplay/src/vehicles.ts`. Data: `packages/gameplay/data/vehicles.json`
(JSON Schema `vehicles.schema.json`). Tests: `packages/gameplay/test/vehicles.test.ts`.

## Classes and defs
Classes: `bicycle`, `car`, `truck`, `van`, `camper`, `semi`, `trailer`, `wagon`, `cart`, `carriage`, `chariot` (the last four are animal-drawn, ADR-358 — see below). Sizes: `xs`, `s`, `m`, `l`, `xl`.

| field | meaning |
|---|---|
| `id` | stable key (`bike_bmx`, `semi_trailer_box`) |
| `class`, `size` | see above. Storage grows with size (tested: average maxWeight strictly increases by size). |
| `seats` | 0..8, seat 0 = driver. Trailers have 0. |
| `mass` | kg. Scales collision damage. |
| `maxSpeed`, `accel`, `brake` | tiles/s, tiles/s². |
| `turn` | max yaw rate (rad/s). |
| `grip` | 0..1. Lower means more drift. |
| `fuel` | `{capacity, perSecond}` at full throttle, or `null`. Required for motor classes, forbidden on bicycles, trailers and drawn vehicles. |
| `covered` | ADR-358, wagons only: `true` = canvas cover over the same footprint as the uncovered twin. |
| `drawn` | ADR-358, drawn classes only: `{pullMul}` — multiplies the pulling mount's current gait speed (see below). |
| `stamina` | `{perSecond}` (bicycles): drains the rider's Survival.stamina. At 0 the bike runs at 35% throttle. |
| `health` | vehicle HP. At 0 the vehicle is wrecked: no throttle and no entering. |
| `storage` | `{slots, maxWeight}` → `Container` on the vehicle. Base slots; the Container gets `storageCapacity` = base x class scale, clamped to the class max in `data/vehicle_storage.json` (<= 96, ADR-098). maxWeight is used as is. |
| `hitches` | `[{at: front|rear, offset, accepts: [class…]}]`. Towing needs the trailer's front hitch to accept the tow's class AND the tow's rear hitch to accept the trailer's class. |
| `interior.stations` | station keys from `stations.json` (campers and camper trailers). |
| `footprint` | `{length, width}` in tiles. Collision tests its 4 corners and centre. |
| `collider.radius` | broad-phase radius for Renderer and Netcode. |

`Vehicle.defId` = index in vehicles.json + 1. **Append only.** `VEHICLE_DEFS_HASH` is mixed into the world schema hash
(salt `gameplay.vehicles`). `loadVehicleDefs(doc)` validates the data and throws if anything is wrong.

Shipped: 9 bicycles (basic, road, mountain, bmx, fat tire, cruiser, tandem, cargo, trike), 5 cars, 3 trucks, 2 vans,
2 campers (van, rv; both with interiors), the semi tractor, and 8 trailers (small utility, medium cargo, large flatbed,
livestock, tanker, camper trailer, semi box, semi flatbed). Semi trailers hitch only to a semi. Animal-drawn (ADR-358):
6 wagons (small / medium / large, each covered and uncovered — covered twins share the uncovered twin's footprint,
seats and storage), 1 cart, 1 carriage, 1 transport chariot.

## Animal-drawn vehicles (ADR-358)
No engine, no fuel, no stamina drain, no `VehicleState` (render gives them no headlight cone). A drawn vehicle never
drives itself: `vehicleSystem` treats every hitched vehicle as a trailer posed by its parent, and an unhitched drawn
vehicle is held at speed 0. The tow is a **tamed mount**, not a vehicle — the mount carries `Hitch` (`towNetId` = the
drawn vehicle's NetId; added to mounts by `makeMount`/`tameMount`, and lazily by `hitchVehicles` for legacy mounts)
and the drawn vehicle's `Hitch.parentNetId` is the mount's NetId. The same `Hitch` link and pin-joint posing serve
both tow kinds; `stepTrailer` and `poseTrailersInHitchFrame` (client, after interpolation) pin the drawn vehicle's
front hitch to the mount's **rear pin** — behind the mount by half its body length (`mounts.json` `size.lengthM` / 2)
plus a 0.3-tile drawbar gap — instead of a vehicle rear hitch. A ridden mount is posed from its rider's Transform
(the rider already moved in the input phase; `mountSystem` snaps the mount there later the same tick), so the pin
stays exact; an unridden mount tows from its own Transform. `validateHitch` rejects motor tows of drawn vehicles
and mount tows of motor trailers as `incompatible` (the drawn front hitch's `accepts` list is empty — mounts are not
a vehicle class, so the rule is the drawn class itself, not the allowlist); `validateUnhitch`/`unhitchVehicle` resolve
the tow by NetId so a mount tow clears both sides. **Harness (ADR-359):** a mount tows a drawn vehicle only while
harnessed — an unharnessed mount attempting to hitch a drawn vehicle is rejected `no_harness` (gating order:
dead → no_hitch → moving → no_harness → too_far → actor_too_far). The Harness is equipment for the mount, not the
player: item `harness` (workbench, leather 2 + rope 2 + iron_ingot 1, 6 s), equipped via `gameplay.mountHarness
{target, slot}` and removed via `gameplay.mountUnharness {target}` (mirrors the saddle commands; unequipping
while hitched is rejected `hitched` — detach first). Detach is `gameplay.vehicleUnhitch`: the vehicle stays parked
and the mount keeps its harness. `MountHarness {item: u16}` (networked + persistent) holds the equipped harness;
a mount that dies drops it in its death loot bag. **Driver seat (ADR-360):** the seat-0 driver steers the pulling
mount — `applyMovementInput`'s Driver branch calls the `DrawnDrive` hook (`driveDrawnVehicle`), which moves the
mount with the same `applyRidingMotion` a mounted rider gets, and the vehicle follows on the pin joint; the
mount's own rider wins if both steer (rider precedence). The driven speed is sim-local (`DrawnDriveSpeeds`,
cleared on exit/unhitch/rider-takeover/dead mount); Sprint gallops, driving never drains the driver's stamina.
The animal AI skips a driven mount (`drawnDriven`), like a ridden one. Riders render at their seat anchors
(`VehicleView.sync` placements, applied in the client for motor and drawn alike); the engine/lights HUD chip
hides for drawn defs. Dedicated art and build-menu icons are ADR-361's: runtime-painted world sprites keyed by
def id (one atlas per def, 8 directions, native scale), harness overlays per mount art, and 13 runtime-painted
menu/kit icons — see ADR-361 in DECISIONS.md. Wheels do not animate (one frame per direction, mid-roll pose);
damage stages are a cut (the renderer never selects them for vehicle bodies).

**Speed (data, not a constant).** `drawnSpeedCap(def, species, galloping) = min(def.maxSpeed, mountWalkOrGallop × def.drawn.pullMul)`.
The cap is enforced on the mount, not the trailer: `installVehicleCraft` registers `drawnTowCap` as the
`RideTowCap` resource (keyed by the mount, ADR-360), and `applyRidingMotion` clamps the target speed to it —
for a mounted rider and for a wagon driver alike — so a laden wagon slows its horse instead of being dragged
faster than its cap. A chariot (`pullMul` 1.2, cap 11.5) does not slow a galloping horse
(9.6) at all, while the same horse pulls a large wagon (`pullMul` 0.55) at 5.0 galloping and 2.97 walking. Sizes are
grounded in the ADR-319 realism table (1 tile = 1 m, player 1.75 m): small wagon 2.6×1.4 m (farm wagon), medium
3.6×1.6 m, large 4.6×1.8 m (Conestoga-scale freight wagon), cart 1.8×1.2 m (single-axle), carriage 3.2×1.6 m
(enclosed coach, 4 seats, less cargo than a wagon of the same size), chariot 1.6×1.1 m (light two-wheel). Kits craft
at the workbench from wooden parts (`wooden_wheel`, `wagon_frame`, `canvas_cover` for covered wagons); repair uses
`wooden_wheel` (field 0.1, garage 0.3, `wreckOk` at a garage). Storage scales by class in `vehicle_storage.json`
(wagon 3/72, cart 2/12, carriage 2/24, chariot 1/4).

## Components (appended after ClanStatus; registration order is append-only)
- `Vehicle {defId u16, speed, heading, fuel, health, drift, steer}`: networked and persistent.
- `VehicleSeats {occupant u32[8]}`: rider NetIds (0 = empty). Networked, not persistent.
- `Driver {vehicleNetId u32, seat u8}`: on the rider. Networked.
- `Hitch {towNetId, parentNetId}`: NetIds. Networked and persistent.
- `VehicleState {flags u8}` (ADR-101): bit 0 engineOn, bit 1 headlights. Powered vehicles only; networked + persistent; appended after `VehicleCondition`.
- Storage is the existing `Container` (spawnVehicle sizes it from the def), so open, deposit, withdraw, viewers and persistence all work unchanged.

World schema hash with default gameplay installed (`new World(); installGameplay(w)`): **0xb629eab2** (ADR-359; was 0xde24c45e before it).

Defs also carry `seatAnchors[]` (one `{x, y, z}` per seat, vehicle-local: x front, y left, z up) and every hitch an `anchor {x, y, z}` (x = ±offset). Render reads them (`seatAnchors`, `hitchU`). Riders' `AnimState` is `Sit` (13) while seated; exit restores `Idle`. Toggles: `gameplay.vehicleEngine` / `gameplay.vehicleHeadlights` `{target, on: 0 off | 1 on | 2 toggle}`, driver (seat 0) only, registered after the vehicle craft commands. `localPlayerVehicle(world, playerEid)` returns the ridden vehicle NetId or null.

## Simulation (`gameplay.vehicles`, simulation phase, right after weather, every peer)
1. Powered vehicles, in NetId order: an arcade kinematic bicycle model. Throttle and steering come from the drive
   input: the target heading is the input direction, and pulling back while slow reverses. Yaw = v·tan(steer)/(0.6·length),
   capped at `turn`. Drift: the velocity angle lags the heading by (1 - grip). Boosting at speed loosens grip.
2. Collision: footprint corners are checked against `movementBlocked` (terrain, walls, doors, solid cells), or against
   `setVehicleBlocker(world, fn)` if one is set. Each axis slides separately. If less than half the step survives, it
   counts as an impact: the vehicle stops, bounces back at -20%, and takes |v|·mass/1000·4 damage.
3. Trailers, parents first: a pin joint places the trailer's front hitch on the tow's rear hitch, and the trailer's
   heading follows the drawbar, clamped to ±1.75 rad (jackknife). Chains such as truck→trailer→trailer work when the allowlists permit them.
4. Riders snap to the vehicle's Transform. `applyMovementInput` routes a seat-0 driver of a hitched drawn vehicle
to the pulling mount (ADR-360 `DrawnDrive` hook); other drivers' input is ignored there.

## Input
The driver's frame goes through `applyGameplayInput`. Analog `moveX/moveY` (or the move bits) and `Sprint` (boost) are
stored with `setDriveInput`, and PlayerIntent.moving is forced to 0 while riding. Bots therefore drive through
`AgentOutput` (moveX, moveY, sprint), and keyboard, gamepad and touch need nothing extra. A drawn vehicle's driver
(ADR-360) steers the pulling mount instead: the same frame also runs the `DrawnDrive` hook through
`applyMovementInput` (the server/client funnel `applyDemoInput` passes the driver's real buttons + analog), so the
mount moves in the input phase and the wagon follows on the pin joint. A passenger's input moves nothing, and a
mount with its own rider is steered by that rider, never by the wagon driver.

## Passengers (ADR-371)
Any seat >= 1 is a passenger seat: boarding it needs no key, and the seat system already snapped every rider
(driver or passenger) to the vehicle's Transform, so drawn-vehicle passenger follow needed no new code. What
ADR-371 adds: (1) seat 254 = first free *passenger* seat (`PASSENGER_SEAT`, `enterVehicleAsPassenger`), which
never takes seat 0 — a key-holder can ride along without stealing the drive; seat 255 still takes the driver
seat first for a key-holder. The client sends seat 254 on Interact when the drawn vehicle already has a driver,
and shows a "Passenger · Interact to get off" chip while riding as one; boarding and dismounting both go
through Interact (E / pad X / touch "Use"), so all three devices work with no new binding. (2) Safe dismount:
`exitVehicle` first tries the legacy left-side spot, then tile centres on expanding rings around the vehicle
(`findSafeDismountTile`, radii in `data/vehicle_passengers.json`), land/shallow first, deep water only as a
last tier, never inside a solid or the footprint; with no safe tile it returns `no_safe_spot` and the rider
stays seated to retry later. (3) Forced exit: a rider whose vehicle entity is gone is ejected to a safe tile
by `vehicleSystem` (`forceExitVehicle` / `ejectVehicleOccupants`); a driver leaving or a mount being unhitched
leaves passengers seated in the parked vehicle, which is safe — they exit on demand, and the `ride_passenger`
bot behaviour exits when its driver has left. (4) AI: `ride_passenger` boards a driven drawn vehicle (wagon /
cart / carriage / chariot) when far from its goal and gets out at its destination when parked, or when the
driver leaves, the wagon is wrecked, or the ride carried it 10 tiles further from its goal than where it
boarded. No new component, no wire change, no new art.

## Commands (validated, ADR-092 path; registered after ClanDeclineCmd)
`gameplay.vehicleEnter {target, seat (255 = first free, 254 = first free passenger seat)}`, `gameplay.vehicleExit {}`,
`gameplay.vehicleHitch {target = trailer, tow}`,
`gameplay.vehicleUnhitch {target}`, `gameplay.vehicleStation {target, station}`. NetId fields are listed in
`COMMAND_ENTITY_FIELDS`. Server: `installVehicleCommands(world, handlers)` (wired in apps/server game.ts).
Interact: the client calls `vehicleInteractCommand(world, player, target)`, which returns exit while riding and enter otherwise.
Rejection reasons: `dead, already_riding, not_vehicle, no_seats, no_net_id, wrecked, too_far, moving, full, bad_seat,
seat_taken, not_riding, no_hitch, incompatible, already_hitched, tow_busy, cycle, actor_too_far, not_hitched, no_station,
no_harness, not_harness, hitched, no_passenger_seats, no_safe_spot` (`no_harness, not_harness, hitched` are the ADR-359
harness reasons, on the mount commands and the drawn hitch path; `no_passenger_seats, no_safe_spot` are ADR-371).

## Camper interior hook API (Survival wires the station logic)
- `vehicleStations(world, v)` → `{index, key, kind}[]` (kind = StationKind from stations.json).
- `usableVehicleStations(world, player, v)`: non-empty only while parked (|speed| < 0.25), with the player seated in
  the vehicle or within length/2 + 2.5 tiles of it.
- `nearbyVehicleStationKinds(world, player)`: a set of usable kinds, for crafting and cooking station checks.
- `addVehicleStationHook(world, {name, onUse(world, player, vehicle, station)})` runs after `useVehicleStation` or the `vehicleStation` command validates.

## EDGE_ACTIONS (append-only)
`EDGE_ACTIONS` in `packages/input/src/defaults.ts` (mirrored by `GAMEPLAY_EDGES` in gameplay input_hooks.ts) is
**append-only**: a bit index is wire format. New edges go at the end of both lists, the tests pin the order, and removed
edges keep their slot. Vehicles add no edges: enter and exit use the existing Interact hold bit through a client-issued command, and boost is Sprint.

## Not done yet / for other teams
Vehicle vs vehicle and vehicle vs creature collision, damage to riders, render interpolation of heading and drift, net
AOI and prediction tuning, recipes that craft vehicles (Survival: spawn with `spawnVehicle`), and sprites keyed by def id (Art).
