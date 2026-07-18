# HANDOFF — Implement "The Big Push" end to end

You are implementing a new mode for MUD & STEEL (WWI trench game, TypeScript + three.js, ~26k LOC): two trench systems facing each other, both commanders buying soldiers who **march in from the rear**, per-section **over the top** assault orders, singleplayer vs an AI commander and lockstep multiplayer — all hosted on Vercel.

Work milestone by milestone until the whole spec is shipped. Do not stop between milestones to ask permission; stop only if genuinely blocked on something only Elliot can do (each such blocker is listed below).

## Read these first

1. `docs/specs/2026-07-18-big-push-spec.html` — **authoritative**: decisions, camera leash, match lengths, Vercel/WebRTC architecture, command protocol, acceptance criteria, workflow shapes.
2. `docs/plans/2026-07-18-big-push-two-trench-mode.html` — reconnaissance (file:line map of every relevant system), design rationale, **refactor ledger** of the ~8 hard-coded one-sided assumptions.
3. `CLAUDE.md` in repo root — dev-server hygiene (always `preview_stop` after verification).
4. Issues [#33](https://github.com/elliothimmelfarb/mud-and-steel/issues/33) (plan) and [#38](https://github.com/elliothimmelfarb/mud-and-steel/issues/38) (spec/decisions) for history.

## Decisions already made — do not relitigate

- **Fog of war = camera leash**: commander camera target cannot cross `advanceZ − 12 m` (your farthest-forward living soldier). Look across freely; travel is earned. `advanceZ` lives on `SimState` (sim data, both clients identical). Exempt: FPS embodiment, game over, replays.
- **Variable match length**: Raid 10 / Battle 20 (default) / Grand Assault 35 / Attrition (untimed). Timed → whistle verdict: enemy front sections held, tie by remaining strength.
- **Symmetric rosters in v1.** National asymmetry is a later push — do not build it.
- **Everything on Vercel**: static game + `/api` serverless signaling (rooms, SDP/ICE via 1 Hz poll, Upstash Redis, 15 min TTL) + WebRTC DataChannel for the match itself. No standing relay server. STUN only in v1.

## State of the world

- Vercel project `elliothimmelfarbs-projects/mud-and-steel` is linked (`vercel.json` in repo, `.vercel/` gitignored); **prod is live at https://mud-and-steel.vercel.app**. Deploy with `vercel deploy --prod --yes`.
- **Blocked on Elliot (ask when relevant, then continue other work):** (1) GitHub↔Vercel login connection for push-to-deploy; (2) Upstash Redis marketplace install when M5 starts.
- The sim is already deterministic (seeded forked RNG, fixed 30 Hz, no `Math.random`/`Date.now`/three.js anywhere in `src/sim/`). Guard this with your life.

## Milestone order (each = issue → branch → PR → merge)

| # | Deliverable | Acceptance gate (from spec §5) |
|---|---|---|
| M0 | Command spine: tick-stamped `Cmd`/`Envelope` (schema in spec §4), all player actions routed through it; barrage/gas/vehicle module globals moved onto `SimState`; headless tick driver extracted from `game.ts`; `advanceZ` per side computed in sim | Twin headless sims, same seed + command log → **identical hashes** over a 20-wave run; classic mode plays unchanged |
| M1 | Mirrored world: `facing` sign through `carveTrench`/dressing/`projectToFireStep`; north trench carved + dressed; symmetric camera clamps; `SoldierRenderer.CAP` → ~900; sunken lane recut at z ≈ 0 | Flyover shows south-facing fire steps/parapets on the north trench; framebuffer readback on both parapets |
| M2 | March-in: `marchingIn` state, rear-edge spawn, comm-trench waypoint pathing, ETA on ghost, scatter-under-fire (both factions). **Camera leash lands here** | Column files up under shellfire; camera cannot cross leash; boundary eases ~3 s on deaths, ~0.5 s on advance |
| M3 | Over the top: faction-neutral squad AI (graft `Enemy` behaviour struct onto player soldiers — option (b), see ledger); per-faction flow fields; section-stretch selection UX; orders (assault/covering/recall/consolidate); symmetric capture; strength pools; match-length verdicts | Scripted assault probe: bound, cut wire, melee, capture, recall, consolidate. All three timed lengths end with correct verdict |
| M4 | AI commander: `planWave` director reframed as command emitter; 3 personas (Methodical/Stosstrupp/Opportunist); balance lab. **SHIP: title-screen entry "The Big Push"** | 50 headless AI-vs-AI matches: no stalls, correct termination on every length; playtest each persona |
| M5 | P2P lockstep: `/api` signaling routes + Upstash; lobby + 4-letter room codes; T+6 command scheduling; hash exchange every 30 ticks; snapshot resync (room creator wins); AI takeover on disconnect; rejoin via log replay. **SHIP: multiplayer** | Two browsers through live Vercel signaling → 30 min hash-clean; kill a client mid-assault, rejoin lands in the identical battle |
| M6 | Polish: FPS embodiment intents in the protocol (local prediction); spectate + replay viewer; TURN/long-poll fallback only if STUN failure data demands | Embodied MP firefight hash-clean; replay byte-identical to live |

## How to run it — workflows

Elliot has opted into workflow orchestration for this project. Per milestone (shapes in spec §6):

- **Scout inline first** (find the call sites, enumerate the work-list), then `Workflow` to pipeline over it. Prefer `pipeline()` — barriers only when a stage genuinely needs all prior results.
- **Delegate to Opus** (`model:'opus'` on `agent()` calls) for mechanical, enumerable stages: call-site sweeps, mirroring code along a parameter, config plumbing, probe/lobby scaffolds, balance sweeps. Use `effort:'low'` for the most mechanical of these.
- **Keep on the session model (Fable)**: seam design, netcode, anything that can move a hash, and every adversarial-verify/judge stage.
- **Adversarial verify before merging any determinism-touching PR**: ≥3 skeptic agents independently try to produce divergence (module-level state, iteration order, `Math.sin/cos/pow` call sites, command/tick races). A finding kills the merge until fixed.
- Worktree isolation (`isolation:'worktree'`) only when agents mutate files in parallel.

## Invariants — violating any of these is a bug even if it looks fine

- **Determinism**: sim randomness only via `ctx.rand` forks; no wall clock, no `Math.random`, no module-level mutable state in `src/sim/` (M0 removes the three existing offenders); commands applied only at tick boundaries.
- **Terrain-height-is-cover**: cover is real heightfield geometry. `fireStepLift` is the same constant as `ballistics.standSurface` — carve and cover model must never drift. A mirrored trench needs real bench geometry, same as south.
- **Shared preTrench snapshot**: all trench lines carve against one pristine snapshot (union at one floor). Add the north system to the same pass; never re-dig.
- **benchGuard**: comm-trench junctions must not re-dig the fire-step bench.
- **Template-clone**: never build heavy meshes synchronously per spawn — build once, `clone(true)` per instance (see Scenery tanks, HorsePool).
- **churn vs churnVis**: gameplay mud and visual mud stay separate arrays.
- **Instancing**: soldiers stay in the 14-part instanced renderer; raise `CAP`, don't fork the pattern.
- **Sim purity**: nothing in `src/sim/` imports three.js or render modules; render reads sim via queues (`s.fx`, `s.sounds`) and typed events.

## Verification & hygiene

- The game **auto-pauses on hidden tabs** — drive probes via `window.__game.frame(dt)` manually. Beware multiple dev servers/tabs poisoning live probes; run one server, kill it after (`preview_stop`).
- Existing harnesses: `?fpslab` (FPS sandbox + `runTacticsProbe`/`runDirectorProbe`), `?gallery` (model/terrain viewer). Add `?bigpush` for the new mode plus a headless twin-sim hash probe (M0's deliverable, then every PR runs it).
- `npm run typecheck` and `npm run build` before every PR. Deploy to Vercel after each ship-gate merge.
- **Never use `claude -p`** (billing). Commit often; small checkpoints.
- Reports/despatches → `docs/reports/YYYY-MM-DD-slug.html` (visual HTML, despatch style — copy the tokens from existing reports).

## When you finish

Ship gates: M4 = singleplayer live on Vercel; M5 = multiplayer live. After each gate: deploy, write a despatch report, and tell Elliot what shipped, what's next, and any blockers (GitHub connect / Upstash install) still outstanding.
