# MUD & STEEL — Hold the Line, 1916

A fully procedural WWI trench wave-defence game for the browser. WebGL (three.js),
zero external assets — terrain, men, machines, textures, UI, **and every sound**
are generated in code. One 220 KB gzip bundle.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in dist/
```

## What it is

You command a battalion sector in Flanders, summer 1916: a zigzag front trench,
a support line, and the mud between. Waves attack from the north. Place named
soldiers, crewed weapons, and field defences; survive to wave 20 to be relieved,
then keep going in endless if you can bear it.

### Systems that make it different

- **Deformable battlefield** — every shell digs a real crater into the heightfield.
  Craters change cover, pathfinding, and (when it rains) flood into tank-swallowing
  ponds. The map you finish on is not the map you started with.
- **Live weather & wind** — gas drifts with a simulated wind field. The vane turns
  red when your own phosgene will blow back over your parapet.
- **Morale & suppression** — both armies duck, crawl, break, and rout. Machine-gun
  fire pins men in the shell holes your own mortars dug for them.
- **An adaptive enemy** — the director studies what kills its men and buys
  counters: snipers for your Vickers crews, pioneers for your wire, dispersed
  storm parties for your artillery. Read the intelligence report between waves.
- **Named men, letters home** — every soldier has a name. Survivors write
  procedurally-generated letters home after hard waves; the fallen go on the
  Roll of Honour with an epitaph.
- **Orders** — Take Cover, Rapid Fire, Fix Bayonets, Gas Masks, flares, a creeping
  barrage that walks north, and a Mark IV you can send over the top (it will
  crush your own wire on the way — steel doesn't ask).

### Controls

Everything is playable with mouse alone or keyboard alone (Mac/Windows).
`WASD`/arrows pan · `Q/E` rotate · wheel/`Z/X` zoom · `1–9 0 - =` units ·
`F1–F6` defences · arrows move the placement cursor · `Enter` place ·
`Space` pause · `[ ]` speed · `N` sound the advance · `H` field manual.
All binds remappable in Settings.

Seeded runs: enter a Service No. on the title screen; share it from the
game-over screen.

## Architecture

- `src/core` — types, config/balance tables, RNG, save, flavor (names/letters)
- `src/world` — deformable terrain + mesh/shader, sky/lighting, weather sim
- `src/sim` — 30 Hz fixed-step sim: combat model, both armies' AI, flow-field
  pathfinding, projectiles, gas, vehicles, adaptive wave director, barrages
- `src/render` — renderer/post, instanced soldier rig, procedural props, VFX
- `src/audio` — WebAudio synthesis engine (34 sfx + 7 loops, no files)
- `src/ui` — screens, HUD, stylesheet

Built with Claude Code.
