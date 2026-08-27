# Agent guide — MUD & STEEL

A procedural WWI trench wave-defence game. TypeScript 5.7, three.js r172, Vite 6. Zero external assets: every model, texture, and sound is generated in code.

## Commands

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm run typecheck  # tsc --noEmit — run before every commit
npm run build      # production bundle
```

CI runs typecheck + build + a changelog gate on every PR.

## Where things live

- `src/core` — types, config/balance tables, seeded RNG, save, name/letter flavor
- `src/world` — deformable terrain heightfield + shaders, sky/lighting, weather
- `src/sim` — the 30 Hz fixed-step simulation: ballistics, both armies' AI, flow-field pathfinding, gas, the adaptive director. Deterministic; never read wall-clock time inside it.
- `src/game` — orchestration, RTS layer, first-person embodiment (`fps.ts`, `weapons.ts`)
- `src/render` — renderer, post chain, instanced soldiers, procedural props, pooled VFX
- `src/audio` — WebAudio synthesis engine (all sound is synthesized, no files)
- `src/net` — P2P lockstep multiplayer; `api/` holds the Vercel signaling functions
- `src/ui` — screens, HUD, stylesheet

## Rules of the road

- The sim is fixed-step and seeded. Anything that would desync lockstep multiplayer (wall-clock reads, unseeded randomness, float nondeterminism from render state) is a bug.
- No asset files, ever. New models/textures/sounds are code.
- Two dev harnesses exist for verification: `?fpslab` (weapon sandbox/turntable) and `?gallery` (model contact sheet). Use them before claiming visual work is done.
- Update the in-game Despatches changelog with player-visible changes; CI gates on it.
- Stop any dev server you start (see CLAUDE.md).
