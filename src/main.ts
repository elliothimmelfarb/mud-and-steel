/**
 * Boot: settings, audio, game, HUD, title screen, main loop.
 */
import './ui/style.css'
import { AudioEngine } from './audio/audio'
import { loadSettings, loadRun, highScore, clearRun } from './core/save'
import { Game } from './game/game'
import { Hud, helpSections, settingsSchema } from './ui/hud'
import { createHelpOverlay, createSettingsPanel, createTitleScreen } from './ui/screens'
import { defaultSettings, saveSettings } from './core/save'
import { keyLabel } from './render/controls'

const VERSION = '1.0.0'

function bootProgress(p: number): void {
  const bar = document.getElementById('boot-bar')
  if (bar) bar.style.width = `${Math.round(p * 100)}%`
}

function main(): void {
  const app = document.getElementById('app')
  if (!app) throw new Error('missing #app')
  bootProgress(0.2)

  // Dev-only model/terrain viewer (see game/modelGallery.ts). Boots a studio
  // scene INSTEAD of the game — no audio, sim or HUD.
  if (new URLSearchParams(location.search).has('gallery')) {
    document.getElementById('boot')?.classList.add('done')
    import('./game/modelGallery').then(({ startModelGallery }) => startModelGallery(app))
    return
  }

  // The Big Push lab: headless twin-sim determinism probe (M0). Grows into
  // the two-trench mode harness as the milestones land. No game boot needed.
  if (new URLSearchParams(location.search).has('bigpush')) {
    document.getElementById('boot')?.classList.add('done')
    import('./game/twinSimLab').then(({ startTwinSimLab }) => startTwinSimLab(app))
    return
  }

  const settings = loadSettings()
  const audio = new AudioEngine()
  // WebAudio needs a user gesture; unlock on the first interaction.
  const unlock = () => audio.unlock()
  window.addEventListener('pointerdown', unlock, { once: false })
  window.addEventListener('keydown', unlock, { once: false })

  const game = new Game(app, audio, settings)
  ;(window as unknown as { __game: Game }).__game = game // debug/console access
  bootProgress(0.6)
  const hud = new Hud(game, document.body)
  game.applySettings(settings)
  bootProgress(0.9)

  let title: { el: HTMLElement; dispose: () => void } | null = null
  let stack: Array<{ el: HTMLElement; dispose: () => void }> = []

  const closeStack = (scr: { el: HTMLElement; dispose: () => void }) => {
    const i = stack.indexOf(scr)
    if (i >= 0) stack.splice(i, 1)
    scr.dispose()
    scr.el.remove()
  }

  const openTitleSettings = () => {
    const scr = createSettingsPanel({
      schema: settingsSchema(),
      values: {
        ...(game.settings as unknown as Record<string, unknown>),
        ...Object.fromEntries(Object.entries(game.input.getBinds()).map(([a, c]) => [`bind.${a}`, keyLabel(c)])),
      },
      onChange: (key, value) => {
        if (key.startsWith('bind.')) game.settings.keybinds[key.slice(5)] = value as string
        else (game.settings as unknown as Record<string, unknown>)[key] = value
        game.applySettings(game.settings)
        saveSettings(game.settings)
      },
      onClose: () => { game.input.cancelCapture(); closeStack(scr) },
      onReset: () => {
        game.settings = defaultSettings()
        game.applySettings(game.settings)
        saveSettings(game.settings)
      },
      onRebind: (_key, cb) => game.input.captureNextKey(cb),
    })
    stack.push(scr)
    document.body.appendChild(scr.el)
  }

  const openTitleHelp = () => {
    const scr = createHelpOverlay({ sections: helpSections(), onClose: () => closeStack(scr) })
    stack.push(scr)
    document.body.appendChild(scr.el)
  }

  const showTitle = () => {
    // Leaving a live MP match: send the bye so the peer's AI takes over (or
    // the walkover fires) instead of gate-freezing them forever.
    game.leaveMatch()
    game.running = false
    const save = loadRun()
    title = createTitleScreen({
      hasSave: save !== null,
      highScore: highScore() || null,
      version: VERSION,
      onNewGame: ({ difficulty, seed }) => {
        audio.unlock()
        clearRun()
        hideTitle()
        game.endless = false
        game.startRun(seed, difficulty)
      },
      onBigPush: ({ length, persona, seed }) => {
        audio.unlock()
        hideTitle()
        game.startRun(seed, 'front', null, 'bigpush', { matchLen: length, persona })
      },
      onBigPushNet: ({ role, code, length, seed, status }) => {
        audio.unlock()
        void startBigPushNet(role, code, length, seed, status)
      },
      onWarDiary: loadWarDiary() ? () => {
        const rec = loadWarDiary()
        if (!rec) return
        audio.unlock()
        hideTitle()
        game.startReplay(rec)
      } : undefined,
      onContinue: () => {
        audio.unlock()
        const s = loadRun()
        hideTitle()
        if (s) {
          game.endless = s.wave > 20
          game.startRun(s.seed, s.difficulty, s)
        } else {
          game.startRun(String(Date.now() % 1e6), 'front')
        }
      },
      onSettings: openTitleSettings,
      onHelp: openTitleHelp,
    })
    document.body.appendChild(title.el)
  }

  const loadWarDiary = (): import('./game/game').ReplayRecord | null => {
    try {
      const raw = localStorage.getItem(Game.REPLAY_KEY)
      if (!raw) return null
      const rec = JSON.parse(raw) as import('./game/game').ReplayRecord
      return rec.v === 1 && rec.seedStr && Array.isArray(rec.envs) ? rec : null
    } catch { return null }
  }

  const hideTitle = () => {
    if (title) { title.dispose(); title.el.remove(); title = null }
    for (const s of stack) { s.dispose(); s.el.remove() }
    stack = []
  }

  /**
   * The Big Push, human vs human. Rendezvous (Vercel mailbox + WebRTC, or a
   * BroadcastChannel between two local tabs), then the hi/hello terms
   * handshake, then hand the open transport to the game.
   */
  let netConnecting = false
  const startBigPushNet = async (
    role: 'host' | 'join' | 'local-host' | 'local-join',
    code: string,
    length: import('./core/types').MatchLength,
    seed: string,
    status: (line: string) => void,
  ): Promise<void> => {
    if (netConnecting) { status('already connecting — one attempt at a time'); return }
    netConnecting = true
    const { helloAsHost, helloAsJoiner, connectRtc, createRoom } = await import('./net/signaling')
    const { BroadcastTransport } = await import('./net/transport')
    try {
      let terms
      let roomUsed: string
      let kind: 'rtc' | 'local'
      if (role === 'local-host' || role === 'local-join') {
        kind = 'local'
        roomUsed = code || 'LOCL'
        const me = role === 'local-host' ? 'host' : 'join'
        status(`two-tab room "${roomUsed}" — waiting for the other tab…`)
        const t = new BroadcastTransport(roomUsed, me)
        terms = me === 'host' ? await helloAsHost(t, seed, length) : await helloAsJoiner(t)
      } else if (role === 'host') {
        kind = 'rtc'
        status('opening a room…')
        const { code: roomCode } = await createRoom()
        roomUsed = roomCode
        status(`ROOM ${roomCode} — read this code to your opponent`)
        const t = await connectRtc(roomCode, 'host', (l) => status(`ROOM ${roomCode} — ${l}`))
        status(`ROOM ${roomCode} — connected, agreeing terms…`)
        terms = await helloAsHost(t, seed, length)
      } else {
        if (!/^[A-Z]{4}$/.test(code)) { status('enter the 4-letter room code first'); return }
        kind = 'rtc'
        roomUsed = code
        status(`joining ${code}…`)
        const t = await connectRtc(code, 'join', (l) => status(`${code} — ${l}`))
        status(`${code} — connected, awaiting terms…`)
        terms = await helloAsJoiner(t)
      }
      hideTitle()
      game.startRun(terms.seedStr, 'front', null, 'bigpush', {
        matchLen: terms.matchLen,
        net: {
          transport: terms.transport, side: terms.side, isCreator: terms.isCreator,
          catchUp: terms.hostTick > 0,
        },
      })
      // If the other side ever drops, hold the door open for them.
      armRejoin(kind, roomUsed, terms.seedStr, terms.matchLen)
    } catch (e) {
      status(`✗ ${(e as Error).message}`)
    } finally {
      netConnecting = false
    }
  }

  /**
   * After a peer drops, the survivor quietly reopens the rendezvous (same
   * room code, or the same BroadcastChannel room) and waits. A returning
   * player just uses the normal Join flow; the hello's tick > 0 makes them
   * requestLog + fast-forward, and attachTransport un-adopts the AI here.
   */
  const armRejoin = (kind: 'rtc' | 'local', room: string, seed: string, length: import('./core/types').MatchLength) => {
    game.onNetPeerLost = () => {
      void (async () => {
        const { connectRtc, helloAsHost } = await import('./net/signaling')
        const { BroadcastTransport } = await import('./net/transport')
        while (game.net?.peerGone && game.running && game.ctx.s.outcome === 'ongoing') {
          let t: import('./net/transport').Transport | null = null
          try {
            t = kind === 'rtc'
              ? await connectRtc(room, 'host', undefined, { fromEnd: true })
              : new BroadcastTransport(room, 'host')
            await helloAsHost(t, seed, length, 120_000, () => game.ctx.s.tick, game.mySide)
            if (!game.net || !game.net.peerGone) { t.close(); return }
            game.net.attachTransport(t)
            return
          } catch (e) {
            t?.close()
            if (String((e as Error).message).includes('room expired')) return // rejoin window closed
            // timed out — reopen and keep waiting while the match lives
          }
        }
      })()
    }
  }

  hud.onQuitToTitle = () => showTitle()
  game.onExitToTitle = () => showTitle()

  // Pause when the tab goes to sleep — except in MP, where paused is ignored
  // and would only leave the HUD's pause state lit after the tab returns.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.running && !game.net) game.paused = true
  })
  // Tab closed / reloaded mid-match: BroadcastChannel has no disconnect
  // signal of its own, and WebRTC's takes seconds — say goodbye properly.
  // Both hooks (some closes skip one); leaveMatch is idempotent. A hard
  // process kill still slips through — heartbeat detection is M6 debt.
  window.addEventListener('pagehide', () => game.leaveMatch())
  window.addEventListener('beforeunload', () => game.leaveMatch())

  // Main loop.
  let last = performance.now()
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    game.frame(dt)
    hud.update(dt)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)

  bootProgress(1)

  // Dev-only first-person verification harness (see game/fpsLab.ts). Skips the
  // title and drops straight onto a sandbox battlefield.
  if (new URLSearchParams(location.search).has('fpslab')) {
    document.getElementById('boot')?.classList.add('done')
    import('./game/fpsLab').then(({ startFpsLab }) => startFpsLab(game))
    return
  }

  // Dev entry for The Big Push until the M4 title-screen card lands:
  // ?play=bigpush drops straight into a two-trench match (classic HUD for now).
  const playMode = new URLSearchParams(location.search).get('play')
  if (playMode === 'bigpush') {
    document.getElementById('boot')?.classList.add('done')
    const p = new URLSearchParams(location.search)
    const len = p.get('len') as import('./core/types').MatchLength | null
    game.startRun(p.get('seed') ?? 'the-big-push', 'front', null, 'bigpush',
      len ? { matchLen: len } : undefined)
    return
  }

  // ?replay — straight into the war diary (dev + shareable convenience).
  if (new URLSearchParams(location.search).has('replay')) {
    const rec = loadWarDiary()
    if (rec) {
      document.getElementById('boot')?.classList.add('done')
      game.startReplay(rec)
      return
    }
  }

  // Dev entry for two-tab lockstep: ?mp=local-host / ?mp=local-join
  // (&room=XXXX&seed=YYYY) — skips the title, drives the BroadcastChannel path.
  const mpMode = new URLSearchParams(location.search).get('mp')
  if (mpMode === 'local-host' || mpMode === 'local-join') {
    document.getElementById('boot')?.classList.add('done')
    const p = new URLSearchParams(location.search)
    void startBigPushNet(
      mpMode, p.get('room') ?? 'LOCL', 'battle', p.get('seed') ?? 'the-big-push',
      // eslint-disable-next-line no-console
      (l) => console.log('[mp]', l),
    )
    return
  }

  setTimeout(() => document.getElementById('boot')?.classList.add('done'), 250)
  showTitle()
}

main()
