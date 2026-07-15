<div align="center">

# MUD &amp; STEEL

### Hold the Line, 1916

A fully procedural WWI trench wave-defence game that runs in the browser — command the sector from above, or drop into the boots of any man on the line and fight his war yourself.

**Every pixel and every sound is generated in code. No image, model, or audio file ships with the game.**

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![three.js](https://img.shields.io/badge/three.js-r172-000000?logo=three.js&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![WebGL](https://img.shields.io/badge/WebGL-post--processed-990000)
![Zero assets](https://img.shields.io/badge/assets-0_files-6b6446)
![Bundle](https://img.shields.io/badge/bundle-~255_KB_gzip-2a2418)

</div>

---

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in dist/
npm run typecheck  # tsc --noEmit
```

No API keys, no assets to download, no backend. Open the page and you're in Flanders.

## What it is

You command a battalion sector in Flanders, summer 1916: a zigzag front trench, a support line, and the churned mud between. Waves come out of the north. In the build phase you place **named soldiers, crewed weapons, and field defences**; then you weather the assault. Survive to **wave 20** to be relieved — then keep going in endless if you can bear it.

It plays as a tower-defence at heart, but almost nothing about it is abstract. Bullets are real bodies in flight. Shells re-dig the ground. Both armies have nerves.

## Fight it in first person

Select any unit and press **`M`** (or double-click a soldier) to stop commanding and start *fighting* — as a rifleman working a bolt, a Lewis or Vickers gunner nursing the jacket, a sniper behind a loophole, a bomber lobbing Mills grenades, the Stokes mortar and 18-pounder over open sights, the flame projector, the Livens gas battery, or the stretcher-bearer and sapper doing their work under fire.

You are not playing a separate mode grafted on the side — **you fire the exact same physically-simulated ordnance every AI crew fires**, and the enemy treats you as one more man on the field. They shoot back at *you*.

The gunfeel is built to carry the weapon's weight:

| | |
|---|---|
| **Handled weapons** | Each weapon is a hand-built model in your hands — the SMLE's snub nose-cap, bolt and charger of .303; the Lewis's finned cooling shroud and pan drum; the Vickers's corrugated water jacket, condenser hose and feeding belt; the Webley's fluted cylinder; a waffle-gridded Mills bomb; the flame lance's burner and gauge |
| **The 18-pounder** | A real field gun, not a grey plate: a recoiling barrel and interrupted-screw breech, hydro-pneumatic recuperators, a dial sight and brass handwheels, framed by a low shield you sight *over* — right-click lays the shot through a magnified telescopic gun sight with a ranged graticule |
| **Muzzle flash** | A barrel-welded burst of fire that flickers frame to frame — not a decal — and, after dark, throws a real warm pool of light across the mud in front of you |
| **Tracers** | Grow out of the muzzle and streak downrange as glowing comet heads; yours burn amber, theirs ember-red. At night each of the nearest rounds carries its own moving light, raking the trench wall and lighting up whatever it passes |
| **Recoil** | A spring model that kicks, climbs over a burst, and recovers to your true aim — the 18-pounder lurches the view, shakes the screen and slams its barrel home |
| **Impacts** | Material-specific: dirt geysers, sandbag dust, sparks off steel, a restrained spray off flesh |
| **Incoming** | A supersonic *crack* and a flinch as a round snaps past your head |
| **Feedback** | Hit markers, a distinct kill marker, and directional indicators pointing back at whoever's hitting you |

> A dev harness lives at [`localhost:5173/?fpslab`](http://localhost:5173/?fpslab) — it drops you straight onto a sandbox battlefield with one-click embodiment of every weapon. **Inspect** floats the gun onto a turntable to spin, drag and zoom through every angle; **Invincible** (default on) pins you so enemy fire never cuts a study short; **Clear foes** and **Flash❄** freeze the field for inspection. Deep-link a weapon with `?fpslab&w=fieldgun&inspect&spin`.

## Systems that make it different

- **Deformable battlefield** — every shell digs a real crater into the heightfield. Craters change cover, pathfinding, and (when it rains) flood into tank-swallowing ponds. The map you finish on is not the map you started with.
- **Live weather &amp; wind** — gas drifts on a simulated wind field. The vane turns red when your own phosgene will blow back over your parapet.
- **A continuous day/night sky** — the sun glides through a real arc, lingering on the dawn and dusk it moves slowest through, and a night wave falls dark over the better part of a minute. After dark the battlefield is lit by its own fire: your muzzle flashes pool on the mud, your tracers rake the wire, parachute flares drift overhead, and shell-bursts throb on the clouds — while the same light carves your first-person weapon out of the blackness. Firing reveals the enemy and betrays your position at once.
- **Morale &amp; suppression** — both armies duck, crawl, break, and rout. Machine-gun fire pins men in the shell holes your own mortars dug for them.
- **An adaptive enemy** — the director studies what kills its men and buys counters: snipers for your Vickers crews, pioneers for your wire, dispersed storm parties for your artillery. Read the intelligence report between waves.
- **Named men, letters home** — every soldier has a name. Survivors write procedurally-generated letters home after hard waves; the fallen go on the Roll of Honour with an epitaph.
- **Orders** — Take Cover, Rapid Fire, Fix Bayonets, Gas Masks, flares, a creeping barrage that walks north, and a Mark IV you can send over the top (it will crush your own wire on the way — steel doesn't ask).

## The line you build

| Crewed weapons | Field defences |
|---|---|
| Rifleman · Lewis Gunner · Vickers MG · Sniper | Barbed Wire · Buried Mine |
| Bomber · Stokes Mortar · 18-Pounder | Sandbag Parapet · Tank Trap |
| Flame Projector · Livens Projector | Searchlight · Flare Post |
| Officer · Stretcher Bearer · Sapper | |

Between waves, spend requisition on a tech tree — Mk VII ammunition, box respirators, periscopic sights, deep dugouts, a field hospital, the creeping-barrage doctrine, and more.

## Controls

Playable with **mouse alone or keyboard alone** (Mac / Windows). Everything is remappable in Settings.

**Command view**

| | |
|---|---|
| Pan / rotate / zoom | `WASD` or arrows · `Q`/`E` · wheel or `Z`/`X` |
| Build units / defences | `1`–`9 0 - =` · `F1`–`F6` |
| Place | move cursor with arrows · `Enter` |
| Pause · speed | `Space` · `[` `]` |
| Sound the advance · field manual | `N` · `H` |
| **Embody the selected unit** | **`M`** (or double-click a soldier) |

**First person**

| | |
|---|---|
| Move · look · sprint | `WASD` · mouse · `Shift` |
| Fire · aim | `LMB` · `RMB` |
| Reload · stance | `R` · `C` |
| Return to command | `M` or `Esc` |

Seeded runs: enter a Service No. on the title screen and share it from the game-over screen.

## Architecture

A 30 Hz fixed-step simulation, decoupled from the render loop, with zero external assets.

- **`src/core`** — types, config/balance tables, seeded RNG, save, flavor (names / letters)
- **`src/world`** — deformable terrain + mesh/shader, sky/lighting, weather sim
- **`src/sim`** — the fixed-step sim: combat &amp; ballistics, both armies' AI, flow-field pathfinding, projectiles, gas, vehicles, the adaptive wave director, barrages
- **`src/game`** — orchestration, the RTS layer, and first-person embodiment (`fps.ts`, `weapons.ts`)
- **`src/render`** — renderer + post chain, instanced soldier rig, procedural props, pooled GPU VFX, round/tracer renderer
- **`src/audio`** — a WebAudio synthesis engine (35 sound effects + 7 loops, no files)
- **`src/ui`** — title / screens, HUD, stylesheet

---

<div align="center">
<sub>Built with <a href="https://claude.com/claude-code">Claude Code</a>.</sub>
</div>
