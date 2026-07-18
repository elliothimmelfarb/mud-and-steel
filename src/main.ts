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
  const startBigPushNet = async (
    role: 'host' | 'join' | 'local-host' | 'local-join',
    code: string,
    length: import('./core/types').MatchLength,
    seed: string,
    status: (line: string) => void,
  ): Promise<void> => {
    const { helloAsHost, helloAsJoiner, connectRtc, createRoom } = await import('./net/signaling')
    const { BroadcastTransport } = await import('./net/transport')
    try {
      let terms
      if (role === 'local-host' || role === 'local-join') {
        const room = code || 'LOCL'
        const me = role === 'local-host' ? 'host' : 'join'
        status(`two-tab room "${room}" — waiting for the other tab…`)
        const t = new BroadcastTransport(room, me)
        terms = me === 'host' ? await helloAsHost(t, seed, length) : await helloAsJoiner(t)
      } else if (role === 'host') {
        status('opening a room…')
        const { code: roomCode } = await createRoom()
        status(`ROOM ${roomCode} — read this code to your opponent`)
        const t = await connectRtc(roomCode, 'host', (l) => status(`ROOM ${roomCode} — ${l}`))
        status(`ROOM ${roomCode} — connected, agreeing terms…`)
        terms = await helloAsHost(t, seed, length)
      } else {
        if (!/^[A-Z]{4}$/.test(code)) { status('enter the 4-letter room code first'); return }
        status(`joining ${code}…`)
        const t = await connectRtc(code, 'join', (l) => status(`${code} — ${l}`))
        status(`${code} — connected, awaiting terms…`)
        terms = await helloAsJoiner(t)
      }
      hideTitle()
      game.startRun(terms.seedStr, 'front', null, 'bigpush', {
        matchLen: terms.matchLen,
        net: { transport: terms.transport, side: terms.side, isCreator: terms.isCreator },
      })
    } catch (e) {
      status(`✗ ${(e as Error).message}`)
    }
  }

  hud.onQuitToTitle = () => showTitle()
  game.onExitToTitle = () => showTitle()

  // Pause when the tab goes to sleep.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.running) game.paused = true
  })

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
    game.startRun(new URLSearchParams(location.search).get('seed') ?? 'the-big-push', 'front', null, 'bigpush')
    return
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
