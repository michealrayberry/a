# Hardcore Cartography (Valheim mod)

In hardcore / no-map worlds, the map works again, but **only at your base**. You also have to
craft a **Wayfinder's Chart** before you can open it.

Out in the field it plays exactly like vanilla hardcore: no minimap, no big map, and you
navigate by landmarks. The game still records where you've been. When you get home you can
unroll the chart and plan your next trip, including checking the boss locations your
Vegvisirs revealed.

## How it plays

| Situation | Result |
|---|---|
| Normal world (map enabled) | Mod does nothing. |
| No-map world, in the field | No minimap. Pressing **M** shows *"Your chart can only be studied at home…"* |
| No-map world, at base, no chart | *"You need a Wayfinder's Chart to read the map"* |
| No-map world, at base, carrying chart | **M** opens the full map. Pins, pings and Vegvisir markers all work. |
| Map open, you walk out of base | The map closes. |
| Reading a Vegvisir away from base | The boss marker should still be added to your map (test step 7), but you have to go home to see it. |

**Wayfinder's Chart**: crafted at a Workbench from 4 Leather scraps, 4 Resin and 2 Coal. It
doesn't stack and weighs 0.5. If you lose it on death, you have to craft another one.

## Config (`BepInEx/config/com.rayberry.hardcorecartography.cfg`)

On a dedicated server, the admin sets these and they sync to all players, so nobody can loosen
them on their own machine.

| Key | Default | Meaning |
|---|---|---|
| `Access.BaseRequirement` | `Bed` | `Bed`: within `BedRadius` of your claimed spawn bed. `Workbench`: within any workbench's build range. `Anywhere`: the chart alone is enough. |
| `Access.BedRadius` | `20` | Meters from your bed that count as "home". |
| `Access.RequireChart` | `true` | Whether you must carry the chart. |
| `Access.AllowMinimapAtBase` | `false` | Shows the corner minimap while at base. |
| `Chart.Recipe` | `LeatherScraps:4,Resin:4,Coal:2` | Crafting cost, as `Prefab:Amount` pairs. |

**Why `Bed` is the default:** a workbench costs 10 wood. If a workbench counted as "base",
players would carry the wood, drop a workbench anywhere, check the map, and break it again,
which defeats the point of the mod. A bed can't be placed casually: it needs a roof, and it
moves your respawn point. That matters in hardcore, where portals are usually off too. So a
forward base still works, but it costs a real decision.

## Build

Requirements: the .NET SDK (6 or newer), and Valheim with **BepInExPack_Valheim** installed.

```bash
cd valheim-hardcore-cartography
dotnet build -c Release
# If your Valheim install isn't found automatically:
dotnet build -c Release -p:VALHEIM_INSTALL="D:\SteamLibrary\steamapps\common\Valheim"
```

The JotunnLib NuGet package finds your Valheim install and makes publicized copies of the game
DLLs on the first build. If `BepInEx/plugins` exists, the built DLL is copied to
`BepInEx/plugins/HardcoreCartography/` automatically.

## Install (players)

1. Install **BepInExPack_Valheim** and **Jotunn**. r2modman / Thunderstore Mod Manager is the
   easiest way.
2. Copy `HardcoreCartography.dll` into `BepInEx/plugins/`.
3. Multiplayer: **every player and the server** need the mod. Jotunn enforces this and shows a
   version-mismatch message otherwise.

## How it works

Vanilla hardcore sets `Game.m_noMap`, and `Minimap` checks that flag throughout its code.
Rather than patching each check, the mod:

1. Clears `Game.m_noMap` while `Minimap.Update`/`LateUpdate` run. Exploration fog, pins and
   input then behave like a normal world. A Harmony *finalizer* always restores the flag, even
   if the game throws an exception mid-frame.
2. Intercepts `Minimap.SetMapMode`. The mod handles every request to show the map there: the
   minimap is always forced off (unless configured on), and the large map only opens if
   `MapAccess.CanOpen` passes.
3. Checks twice a second whether an open map is still allowed, and closes it if not.

Files: `src/Plugin.cs` (config and the chart item), `src/MapAccess.cs` (the rules),
`src/MinimapPatches.cs` (Harmony patches).

## Status: needs an in-game test

This was written without access to Valheim's game DLLs, which are proprietary, so it has
**not been compiled or run**. The Jotunn API calls were checked against Jotunn 2.30.2's
published docs. These game members were written from knowledge of the current Valheim
codebase. If a game patch renamed one, the build fails with a clear compiler error:

- `Game.m_noMap`, `Minimap.SetMapMode(MapMode)`, `Minimap.m_mode`, `Minimap.Update`
- `PlayerProfile.HaveCustomSpawnPoint()` / `GetCustomSpawnPoint()`
- `CraftingStation.HaveBuildStationInRange(string, Vector3)`

### Test checklist

1. **Normal world:** the map and minimap behave like vanilla.
2. **Hardcore world, fresh character:** no minimap, and **M** shows the "claim a bed" message.
3. Craft the chart at a workbench, then place and claim a bed. Standing next to the bed,
   **M** opens the map.
4. Explore about 500 m away, then come back. The explored area is revealed. *(If it isn't,
   the game version skips exploration in no-map worlds; report it and I'll patch
   `UpdateExplore`.)*
5. Open the map at home and walk more than 20 m away: the map closes and a message appears.
6. Drop the chart into a chest, then press **M**: you get the "need a chart" message.
7. Read a Vegvisir in the field, then go home: the boss pin is on the map.
8. Dedicated server: change `BaseRequirement` on the server and confirm the client picks it up.

## Ideas for later

- **Chart your trip on return:** exploration is only written to the map when you get home.
  Die in the field and you lose that trip's discoveries. Very hardcore.
- Make **using** the chart from the hotbar open the map, instead of pressing **M**.
- Let the vanilla Cartography Table share maps between players in no-map worlds.
- A custom model for the chart. Right now it reuses the Leather scraps model.
