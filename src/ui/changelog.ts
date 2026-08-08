/**
 * MUD & STEEL — the war record.
 *
 * Machine-readable changelog, newest entry first. This file is the single
 * source of truth for both the version shown on the title screen
 * (APP_VERSION is the top entry's version) and the scrollable Despatches
 * panel on the main menu.
 *
 * CI enforces freshness: any PR that touches src/ or api/ must also touch
 * this file (scripts/check-changelog.mjs), so the record can never silently
 * go stale. Add a new entry (or extend the top unreleased one) with every
 * player-visible change.
 */

export interface ChangelogEntry {
  /** Semver-ish version string; the top entry's version is APP_VERSION. */
  version: string
  /** ISO date (YYYY-MM-DD) the entry shipped. */
  date: string
  /** Short headline in despatch voice. */
  title: string
  /** Player-facing bullet points. */
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.4.0',
    date: '2026-08-08',
    title: 'Two trenches, one game',
    items: [
      'Fixed: in multiplayer the second player was very nearly a spectator. No build bar, no orders, no stores, no way to send anyone anywhere — four hotkeys that despatched a garrison squad, and nothing else. Both commanders now play the same game.',
      'The German commander posts men from the same roster on his own fire step, marches them up his own communication trenches, wires his own approaches, emplaces his own guns, buys his own doctrine and sends his own sections over the top.',
      'Two of everything that used to be one: each side has its own requisition, its own divisional stores, its own standing orders and cooldowns, its own respirators and its own creeping barrage. Take Cover no longer puts BOTH armies\' heads down.',
      'His men have German names, are mourned on his own roll of honour, and wear feldgrau under a stahlhelm. The roster is the same roster — no statistic differs — but the cards carry his own words and his own money.',
      'Despatches are addressed: promotions, citations, gas alarms, barrage warnings and stores announcements go to the commander they concern instead of both.',
      'The AI commander plays the game you are playing — same roster, same purse, same orders, every command through the same door a human uses. Singleplayer can now take either chair.',
      'A commander who drops mid-match is replaced by his staff whichever side he was on. Losing the British player used to end the battle in an instant walkover.',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-07-27',
    title: 'Over the top — an assault that arrives',
    items: [
      'Fixed: a push sent over the top could not cross no-man\'s-land. Men went to ground under fire and never got up again, while the animation had them running on the spot. They now crawl on, work the shell holes, answer the fire lying down, and get where they were sent.',
      'Enemy wire is an obstacle with a price instead of a wall. Brushing it used to pin a man on the spot for good and break his whole section without a single casualty — now he lies in it and cuts, and engineers cut fastest.',
      'Nerve is a state, not a latch: men shake off suppression in about a second of quiet, so putting fire on THEIR trench visibly lifts the weight off YOUR assault.',
      'A push that loses its cohesion breaks and runs for its own parapet, instead of quietly dying in the mud where you cannot see it.',
      'Your own belt now slows you on the way out — you know your lanes, but the boards still cost you tempo.',
      'The creeping barrage is buyable in the Big Push at last (it was locked behind a wave counter the mode does not have). It is aimed where you are looking, walks a frontage rather than the whole map, and your men lean on it instead of sprinting into their own shells.',
      'Sending men over the top now says so: a despatch naming the objective and the number away, a ring on the objective, and a reason whenever an order is refused.',
      'Soldiers animate from the ground they actually cover — no more full-tilt sprinting on the spot.',
    ],
  },
  {
    version: '1.2.1',
    date: '2026-07-19',
    title: 'A smoother war',
    items: [
      'Sweeping performance pass: the battlefield no longer re-uploads every wire coil, trap and sandbag to the GPU each frame — only when something actually changes.',
      'The frame loop, sky lighting and first-person HUD stopped generating garbage every frame; long fights hitch less.',
      'Simulation hot paths (targeting shortlists, bullet sweeps, squad upkeep) run leaner — identical battles, fewer wasted cycles. Lockstep and war-diary determinism untouched.',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-07-19',
    title: 'The two fronts renamed, the record left open',
    items: [
      'Two clear ways to fight: Trench vs Trench (formerly The Big Push) now leads the roster as the headline mode, with Wave Defence (formerly New Battle) holding the line beneath it.',
      'The Despatches war record is now a standing panel to the right of the menu — always open, no button to press.',
      'Trench vs Trench muster reads plainly now: numbered sections spell out match length and your opposing commander, with proper spacing between them.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-07-18',
    title: 'Marked posts, officer glasses, the war record',
    items: [
      'Claimed fire-step posts are now marked while the man is still marching up — no more discovering a spot is taken only when the cursor turns red.',
      'Officers carry binoculars: embody one and press B to glass the enemy line from ground level.',
      'This despatches panel — the full war record, always up to date, enforced by the build.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-07-18',
    title: 'The Push Is Complete — M6',
    items: [
      'First-person actions joined the lockstep protocol: possession, poses, fire and tool work replay identically on every peer.',
      'War diary: watch a full replay of your last battle from the title screen.',
      'Production rejoin: drop from a live online match and take your seat back.',
      'Multiplayer hardening across signaling, sessions and the lobby.',
    ],
  },
  {
    version: '0.9.0',
    date: '2026-07-18',
    title: 'M5 — Lockstep multiplayer',
    items: [
      'Human-vs-human Big Push over peer-to-peer WebRTC lockstep.',
      'Sessions, signaling and a lobby, all served from Vercel.',
      'Local two-tab mode for drills without a second pair of hands.',
    ],
  },
  {
    version: '0.8.0',
    date: '2026-07-18',
    title: 'The Big Push ships — singleplayer',
    items: [
      'Two-trench assault mode: mirrored world, march-in reinforcements, camera leash.',
      'Over the top: symmetric capture, assault groups, strength pools and battle verdicts.',
      'A German AI commander with three personas — methodical, stosstrupp, opportunist.',
    ],
  },
  {
    version: '0.7.0',
    date: '2026-07-18',
    title: 'Trench realism overhaul',
    items: [
      'Crenellated trench trace, bare churned earth, settled sandbags and seated revetment.',
      'Wire belts in no-man’s-land and a proper German line opposite.',
      'Free unit placement along the fire step — zones replace fixed slots.',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-07-17',
    title: 'Veterancy, tactics & the six-improvement round',
    items: [
      'Soldier veterancy: XP, ranks, perks, deeds and citations.',
      'Coordinated infantry tactics — bounding overwatch, NCOs, a legible director.',
      'HUD and command-layer polish; trench junctions, duckboards and revetment fixed up.',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-07-17',
    title: 'Sound, light & first blood',
    items: [
      'Procedural audio: weapon reports, shell acoustics, battlefield ambience.',
      'Dynamic night lighting — fire lights the field; day and night linger.',
      'First-person mode with physical ballistics, tracers, recoil and the full arsenal.',
      'MUD & STEEL — Hold the Line, 1916: the original trench wave-defence game.',
    ],
  },
]

/** The version the game reports everywhere — always the newest entry's. */
export const APP_VERSION: string = CHANGELOG[0]!.version
