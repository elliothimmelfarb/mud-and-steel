/**
 * MUD & STEEL — Hold the Line, 1916
 * Overlay screens: title, settings, pause, game over, help, intel report, letter.
 *
 * Pure DOM — imports nothing. Every factory returns { el, dispose }; the caller
 * appends/removes `el`. Screens are full-viewport overlays (class "screen"),
 * trap focus while open, and honour Esc to close/back. Styling lives in
 * src/ui/style.css.
 */

// ---------------------------------------------------------------------------
// Public schema types
// ---------------------------------------------------------------------------

export interface SettingsItem {
  key: string;
  label: string;
  hint?: string;
  type: 'slider' | 'toggle' | 'select' | 'keybind';
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
}

export interface SettingsGroup {
  group: string;
  items: SettingsItem[];
}

type ScreenHandle = { el: HTMLDivElement; dispose(): void };

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function div(cls?: string, text?: string): HTMLDivElement {
  return make('div', cls, text);
}

function chit(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = make('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function stamp(text: string, brass = false): HTMLSpanElement {
  const s = make('span', brass ? 'ms-stamp ms-stamp--brass' : 'ms-stamp', text);
  s.setAttribute('aria-hidden', 'true');
  return s;
}

// ---------------------------------------------------------------------------
// Focus management (keyboard parity)
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  const all = root.querySelectorAll<HTMLElement>(FOCUSABLE);
  const out: HTMLElement[] = [];
  for (let i = 0; i < all.length; i++) {
    const n = all[i]!;
    // Skip anything inside a hidden subtree.
    if (n.closest('[hidden]')) continue;
    out.push(n);
  }
  return out;
}

function focusFirst(root: HTMLElement): number {
  return requestAnimationFrame(() => {
    const f = focusables(root);
    (f[0] ?? root).focus();
  });
}

/** Stack of open screens so Esc only acts on the topmost one. */
const screenStack: HTMLElement[] = [];

function isTopScreen(el: HTMLElement): boolean {
  return screenStack[screenStack.length - 1] === el;
}

interface Shell {
  el: HTMLDivElement;
  /** Register a cleanup function to run on dispose. */
  own(fn: () => void): void;
  dispose(): void;
}

/**
 * Create the common screen chrome: overlay root, grain layer, focus trap,
 * Esc handling (topmost screen only), initial focus, dispose plumbing.
 */
function screenShell(cls: string, label: string, onEscape: (() => void) | null): Shell {
  const el = div('screen ' + cls);
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', label);

  const cleanups: Array<() => void> = [];

  screenStack.push(el);
  cleanups.push(() => {
    const i = screenStack.indexOf(el);
    if (i >= 0) screenStack.splice(i, 1);
  });

  // Focus trap: cycle Tab within the screen.
  const onTrapKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const f = focusables(el);
    if (f.length === 0) {
      e.preventDefault();
      return;
    }
    const first = f[0]!;
    const last = f[f.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === el || !(active instanceof Node) || !el.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || active === el || !(active instanceof Node) || !el.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };
  el.addEventListener('keydown', onTrapKey);

  if (onEscape) {
    const onDocKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTopScreen(el)) {
        e.preventDefault();
        onEscape();
      }
    };
    document.addEventListener('keydown', onDocKey);
    cleanups.push(() => document.removeEventListener('keydown', onDocKey));
  }

  const grain = div('grain');
  grain.setAttribute('aria-hidden', 'true');
  el.appendChild(grain);

  const raf = focusFirst(el);
  cleanups.push(() => cancelAnimationFrame(raf));

  let disposed = false;
  return {
    el,
    own(fn: () => void): void {
      cleanups.push(fn);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]!();
    },
  };
}

// ---------------------------------------------------------------------------
// Roving-tabindex radio/tab groups (arrow-key navigation)
// ---------------------------------------------------------------------------

function rovingGroup(
  items: HTMLElement[],
  initial: number,
  attr: 'aria-checked' | 'aria-selected',
  onChange: (index: number) => void,
): { setActive(i: number): void } {
  const setActive = (idx: number, moveFocus: boolean): void => {
    for (let j = 0; j < items.length; j++) {
      const it = items[j]!;
      it.tabIndex = j === idx ? 0 : -1;
      it.setAttribute(attr, j === idx ? 'true' : 'false');
    }
    if (moveFocus) items[idx]!.focus();
    onChange(idx);
  };

  items.forEach((it, i) => {
    it.addEventListener('click', () => setActive(i, false));
    it.addEventListener('keydown', (e: KeyboardEvent) => {
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % items.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      if (next >= 0) {
        e.preventDefault();
        setActive(next, true);
      }
    });
  });

  setActive(initial, false);
  return { setActive: (i: number) => setActive(i, false) };
}

// ---------------------------------------------------------------------------
// Small format helpers
// ---------------------------------------------------------------------------

const KEY_NAMES: Record<string, string> = {
  Space: 'SPACE',
  Escape: 'ESC',
  Enter: 'ENTER',
  Tab: 'TAB',
  Backspace: 'BKSP',
  Delete: 'DEL',
  ArrowLeft: '←',
  ArrowUp: '↑',
  ArrowRight: '→',
  ArrowDown: '↓',
  ShiftLeft: 'SHIFT',
  ShiftRight: 'R-SHIFT',
  ControlLeft: 'CTRL',
  ControlRight: 'R-CTRL',
  AltLeft: 'ALT',
  AltRight: 'R-ALT',
  MetaLeft: 'META',
  MetaRight: 'R-META',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
};

function prettyKey(code: string): string {
  if (code === '') return '—';
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
  return KEY_NAMES[code] ?? code.toUpperCase();
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-GB');
}

function fmtSliderValue(n: number, step: number): string {
  return step < 1 ? n.toFixed(2) : String(Math.round(n));
}

function randomSeed(): string {
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += Math.floor(Math.random() * 36).toString(36);
  }
  return s.toUpperCase();
}

// ---------------------------------------------------------------------------
// TITLE SCREEN
// ---------------------------------------------------------------------------

export function createTitleScreen(o: {
  hasSave: boolean;
  highScore: number | null;
  version: string;
  onNewGame: (x: { difficulty: 'quiet' | 'front' | 'push'; seed: string }) => void;
  onBigPush?: (x: { length: 'raid' | 'battle' | 'grand' | 'attrition'; persona: 'methodical' | 'stosstrupp' | 'opportunist'; seed: string }) => void;
  /**
   * Online / local-two-tab Big Push. The screen stays dumb: it hands over the
   * chosen terms plus a status sink; main.ts runs the signaling dance and
   * reports progress lines back into the panel.
   */
  onBigPushNet?: (x: {
    role: 'host' | 'join' | 'local-host' | 'local-join';
    code: string;
    length: 'raid' | 'battle' | 'grand' | 'attrition';
    seed: string;
    status: (line: string) => void;
  }) => void;
  /** Watch the recorded last battle (shown only when a war diary exists). */
  onWarDiary?: () => void;
  onContinue: () => void;
  onSettings: () => void;
  onHelp: () => void;
}): ScreenHandle {
  let page: 'main' | 'new' | 'bigpush' = 'main';

  const shell = screenShell('title-screen', 'Mud & Steel — title', () => {
    if (page !== 'main') showMain();
  });
  const { el } = shell;

  // Battlefield backdrop + drifting fog.
  const bg = div('title-bg');
  bg.setAttribute('aria-hidden', 'true');
  const fogA = div('fog fog--a');
  fogA.setAttribute('aria-hidden', 'true');
  const fogB = div('fog fog--b');
  fogB.setAttribute('aria-hidden', 'true');
  el.appendChild(bg);
  el.appendChild(fogA);
  el.appendChild(fogB);

  const content = div('title-content');
  el.appendChild(content);

  const logo = make('h1', 'title-logo', 'MUD & STEEL');
  const sub = div('title-sub', 'HOLD THE LINE — FLANDERS, 1916');
  content.appendChild(logo);
  content.appendChild(sub);

  // --- main menu: stack of paper chits ---
  const menu = div('title-menu');
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'Main menu');

  const newBattleBtn = chit('New Battle', 'ms-btn ms-btn--primary', () => showNew());
  menu.appendChild(newBattleBtn);
  if (o.onBigPush) {
    menu.appendChild(chit('The Big Push', 'ms-btn ms-btn--primary', () => showBigPush()));
  }
  if (o.hasSave) {
    menu.appendChild(chit('Continue', 'ms-btn', o.onContinue));
  }
  menu.appendChild(chit('Field Manual', 'ms-btn', o.onHelp));
  menu.appendChild(chit('Settings', 'ms-btn', o.onSettings));
  content.appendChild(menu);

  if (o.highScore !== null) {
    content.appendChild(
      div('title-citation', 'MENTIONED IN DISPATCHES — BEST: ' + fmtNum(o.highScore)),
    );
  }

  // --- new battle panel: difficulty postcards + seed field ---
  const wrap = div('torn-wrap title-new');
  wrap.hidden = true;
  const panel = div('ms-panel torn');
  wrap.appendChild(panel);

  const head = div('title-new__head');
  head.appendChild(make('h2', 'title-new__title', 'ORDERS OF BATTLE'));
  head.appendChild(stamp('SECRET'));
  panel.appendChild(head);

  const cards = div('diff-cards');
  cards.setAttribute('role', 'radiogroup');
  cards.setAttribute('aria-label', 'Difficulty');
  panel.appendChild(cards);

  const DIFFS: Array<{ id: 'quiet' | 'front' | 'push'; name: string; flavor: string }> = [
    { id: 'quiet', name: 'QUIET SECTOR', flavor: '“for the new draft”' },
    { id: 'front', name: 'FRONT LINE', flavor: '“the standard tour”' },
    { id: 'push', name: 'THE BIG PUSH', flavor: '“good luck, lads”' },
  ];

  let difficulty: 'quiet' | 'front' | 'push' = 'front';
  const cardEls: HTMLDivElement[] = [];
  for (const d of DIFFS) {
    const c = div('ms-card diff-card');
    c.setAttribute('role', 'radio');
    const badge = stamp('POSTED', true);
    badge.classList.add('diff-card__badge');
    c.appendChild(badge);
    c.appendChild(div('diff-card__name', d.name));
    c.appendChild(div('diff-card__flavor', d.flavor));
    c.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        c.click();
      }
    });
    cards.appendChild(c);
    cardEls.push(c);
  }
  rovingGroup(cardEls, 1, 'aria-checked', (i) => {
    difficulty = DIFFS[i]!.id;
    for (let j = 0; j < cardEls.length; j++) {
      cardEls[j]!.classList.toggle('ms-card--selected', j === i);
    }
  });

  const seedRow = div('seed-row');
  const seedLabel = make('label', 'seed-row__label', 'SERVICE No. (SEED)');
  seedLabel.htmlFor = 'ms-seed-input';
  const seedInput = make('input', 'seed-input');
  seedInput.id = 'ms-seed-input';
  seedInput.type = 'text';
  seedInput.maxLength = 24;
  seedInput.autocomplete = 'off';
  seedInput.spellcheck = false;
  seedInput.placeholder = 'blank for random draw';
  seedRow.appendChild(seedLabel);
  seedRow.appendChild(seedInput);
  panel.appendChild(seedRow);

  const begin = (): void => {
    const seed = seedInput.value.trim().toUpperCase() || randomSeed();
    o.onNewGame({ difficulty, seed });
  };
  seedInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      begin();
    }
  });

  const actions = div('title-new__actions');
  actions.appendChild(chit('Back', 'ms-btn ms-btn--ghost', () => showMain()));
  actions.appendChild(chit('To the Front', 'ms-btn ms-btn--primary', begin));
  panel.appendChild(actions);

  content.appendChild(wrap);

  // --- The Big Push panel: match length + opposing commander + seed ---
  const bpWrap = div('torn-wrap title-new');
  bpWrap.hidden = true;
  const bpPanel = div('ms-panel torn');
  bpWrap.appendChild(bpPanel);
  {
    const bpHead = div('title-new__head');
    bpHead.appendChild(make('h2', 'title-new__title', 'THE BIG PUSH — TWO ARMIES, ONE FIELD'));
    bpHead.appendChild(stamp('OFFENSIVE'));
    bpPanel.appendChild(bpHead);
  }

  const LENGTHS: Array<{ id: 'raid' | 'battle' | 'grand' | 'attrition'; name: string; flavor: string }> = [
    { id: 'raid', name: 'RAID', flavor: '“ten minutes”' },
    { id: 'battle', name: 'BATTLE', flavor: '“twenty minutes”' },
    { id: 'grand', name: 'GRAND ASSAULT', flavor: '“thirty-five minutes”' },
    { id: 'attrition', name: 'ATTRITION', flavor: '“to the last battalion”' },
  ];
  let bpLength: 'raid' | 'battle' | 'grand' | 'attrition' = 'battle';
  const lenCards: HTMLDivElement[] = [];
  {
    const lenGroup = div('diff-cards');
    lenGroup.setAttribute('role', 'radiogroup');
    lenGroup.setAttribute('aria-label', 'Match length');
    bpPanel.appendChild(lenGroup);
    for (const L of LENGTHS) {
      const c = div('ms-card diff-card');
      c.setAttribute('role', 'radio');
      c.appendChild(div('diff-card__name', L.name));
      c.appendChild(div('diff-card__flavor', L.flavor));
      c.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.click(); }
      });
      lenGroup.appendChild(c);
      lenCards.push(c);
    }
    rovingGroup(lenCards, 1, 'aria-checked', (i) => {
      bpLength = LENGTHS[i]!.id;
      for (let j = 0; j < lenCards.length; j++) lenCards[j]!.classList.toggle('ms-card--selected', j === i);
    });
  }

  const PERSONAS: Array<{ id: 'methodical' | 'stosstrupp' | 'opportunist'; name: string; flavor: string }> = [
    { id: 'methodical', name: 'GEN. VON HALTEN', flavor: '“methodical — digs in, probes, answers”' },
    { id: 'stosstrupp', name: 'OBST. STURMFELD', flavor: '“stosstrupp — hoards, then hammers”' },
    { id: 'opportunist', name: 'MAJ. FUCHS', flavor: '“opportunist — finds the thin stretch”' },
  ];
  let bpPersona: 'methodical' | 'stosstrupp' | 'opportunist' = 'methodical';
  const perCards: HTMLDivElement[] = [];
  {
    const perGroup = div('diff-cards');
    perGroup.setAttribute('role', 'radiogroup');
    perGroup.setAttribute('aria-label', 'Opposing commander');
    bpPanel.appendChild(perGroup);
    for (const P of PERSONAS) {
      const c = div('ms-card diff-card');
      c.setAttribute('role', 'radio');
      c.appendChild(div('diff-card__name', P.name));
      c.appendChild(div('diff-card__flavor', P.flavor));
      c.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.click(); }
      });
      perGroup.appendChild(c);
      perCards.push(c);
    }
    rovingGroup(perCards, 0, 'aria-checked', (i) => {
      bpPersona = PERSONAS[i]!.id;
      for (let j = 0; j < perCards.length; j++) perCards[j]!.classList.toggle('ms-card--selected', j === i);
    });
  }

  const bpSeedRow = div('seed-row');
  const bpSeedLabel = make('label', 'seed-row__label', 'SECTOR MAP (SEED)');
  bpSeedLabel.htmlFor = 'ms-bp-seed-input';
  const bpSeedInput = make('input', 'seed-input');
  bpSeedInput.id = 'ms-bp-seed-input';
  bpSeedInput.type = 'text';
  bpSeedInput.maxLength = 24;
  bpSeedInput.autocomplete = 'off';
  bpSeedInput.spellcheck = false;
  bpSeedInput.placeholder = 'blank for random draw';
  bpSeedRow.appendChild(bpSeedLabel);
  bpSeedRow.appendChild(bpSeedInput);
  bpPanel.appendChild(bpSeedRow);

  const bpBegin = (): void => {
    const seed = bpSeedInput.value.trim().toUpperCase() || randomSeed();
    o.onBigPush?.({ length: bpLength, persona: bpPersona, seed });
  };
  bpSeedInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); bpBegin(); }
  });
  {
    const bpActions = div('title-new__actions');
    bpActions.appendChild(chit('Back', 'ms-btn ms-btn--ghost', () => showMain()));
    bpActions.appendChild(chit('Over the Top', 'ms-btn ms-btn--primary', bpBegin));
    if (o.onWarDiary) bpActions.appendChild(chit('War Diary', 'ms-btn ms-btn--ghost', () => o.onWarDiary?.()));
    bpPanel.appendChild(bpActions);
  }

  // --- Online: two human commanders over WebRTC (or two local tabs) ---
  if (o.onBigPushNet) {
    const netHead = make('h3', 'title-new__subtitle', 'AGAINST ANOTHER COMMANDER');
    netHead.style.cssText = 'margin:1.1rem 0 .4rem;letter-spacing:.14em;font-size:.72rem;opacity:.75';
    bpPanel.appendChild(netHead);

    const statusLine = div('seed-row__label');
    statusLine.style.cssText = 'min-height:1.2em;margin-top:.45rem;opacity:.85';
    const status = (line: string): void => { statusLine.textContent = line; };

    const codeRow = div('seed-row');
    const codeLabel = make('label', 'seed-row__label', 'ROOM CODE');
    codeLabel.htmlFor = 'ms-bp-room-input';
    const codeInput = make('input', 'seed-input');
    codeInput.id = 'ms-bp-room-input';
    codeInput.type = 'text';
    codeInput.maxLength = 4;
    codeInput.autocomplete = 'off';
    codeInput.spellcheck = false;
    codeInput.placeholder = 'from your opponent';
    codeInput.style.textTransform = 'uppercase';
    codeRow.appendChild(codeLabel);
    codeRow.appendChild(codeInput);
    bpPanel.appendChild(codeRow);

    const netGo = (role: 'host' | 'join' | 'local-host' | 'local-join'): void => {
      const seed = bpSeedInput.value.trim().toUpperCase() || randomSeed();
      o.onBigPushNet?.({ role, code: codeInput.value.trim().toUpperCase(), length: bpLength, seed, status });
    };
    const netActions = div('title-new__actions');
    netActions.appendChild(chit('Host a Match', 'ms-btn', () => netGo('host')));
    netActions.appendChild(chit('Join with Code', 'ms-btn', () => netGo('join')));
    netActions.appendChild(chit('Two Tabs: Host', 'ms-btn ms-btn--ghost', () => netGo('local-host')));
    netActions.appendChild(chit('Two Tabs: Join', 'ms-btn ms-btn--ghost', () => netGo('local-join')));
    bpPanel.appendChild(netActions);
    bpPanel.appendChild(statusLine);
    codeInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); netGo('join'); }
    });
  }
  content.appendChild(bpWrap);

  const version = div('title-version', o.version);
  el.appendChild(version);

  function showNew(): void {
    page = 'new';
    menu.hidden = true;
    wrap.hidden = false;
    bpWrap.hidden = true;
    cardEls[1]!.focus();
  }
  function showBigPush(): void {
    page = 'bigpush';
    menu.hidden = true;
    wrap.hidden = true;
    bpWrap.hidden = false;
    lenCards[1]!.focus();
  }
  function showMain(): void {
    page = 'main';
    wrap.hidden = true;
    bpWrap.hidden = true;
    menu.hidden = false;
    newBattleBtn.focus();
  }

  return { el, dispose: shell.dispose };
}

// ---------------------------------------------------------------------------
// SETTINGS PANEL
// ---------------------------------------------------------------------------

export function createSettingsPanel(o: {
  schema: SettingsGroup[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  onClose: () => void;
  onReset: () => void;
  onRebind?: (key: string, cb: (code: string) => void) => void;
}): ScreenHandle {
  const shell = screenShell('settings-screen', 'Field settings', o.onClose);
  const { el } = shell;

  const panel = div('ms-panel settings-panel');
  el.appendChild(panel);

  const head = div('settings-head');
  head.appendChild(make('h2', 'settings-title', 'FIELD SETTINGS'));
  head.appendChild(stamp('FOR OFFICIAL USE'));
  panel.appendChild(head);

  // Manila-folder tabs, one per group.
  const tabs = div('settings-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Setting groups');
  panel.appendChild(tabs);

  const body = div('settings-body ms-scroll');
  panel.appendChild(body);

  const tabEls: HTMLButtonElement[] = [];
  const sectionEls: HTMLDivElement[] = [];

  // While a fallback rebind capture is live, keep its remover here so dispose
  // can clean it up (and Esc can cancel it).
  let cancelFallbackRebind: (() => void) | null = null;
  shell.own(() => {
    if (cancelFallbackRebind) cancelFallbackRebind();
  });

  for (let g = 0; g < o.schema.length; g++) {
    const group = o.schema[g]!;
    const tab = make('button', 'settings-tab', group.group);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.id = 'ms-tab-' + g;
    tabs.appendChild(tab);
    tabEls.push(tab);

    const section = div('settings-section');
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', tab.id);
    section.hidden = g !== 0;
    body.appendChild(section);
    sectionEls.push(section);

    for (const item of group.items) {
      section.appendChild(buildSettingsRow(item));
    }
  }

  if (tabEls.length > 0) {
    rovingGroup(tabEls, 0, 'aria-selected', (i) => {
      for (let j = 0; j < sectionEls.length; j++) sectionEls[j]!.hidden = j !== i;
    });
  }

  const foot = div('settings-foot');
  foot.appendChild(chit('Reset to Standing Orders', 'ms-btn ms-btn--ghost ms-btn--small', o.onReset));
  foot.appendChild(chit('Done', 'ms-btn ms-btn--primary', o.onClose));
  panel.appendChild(foot);

  function buildSettingsRow(item: SettingsItem): HTMLDivElement {
    const row = div('settings-row');
    const label = make('span', 'settings-row__label', item.label);
    label.id = 'ms-set-label-' + item.key;
    row.appendChild(label);
    if (item.hint) {
      row.appendChild(make('span', 'settings-row__hint', item.hint));
    }
    const control = div('settings-row__control');
    row.appendChild(control);

    switch (item.type) {
      case 'slider': {
        const min = item.min ?? 0;
        const max = item.max ?? 1;
        const step = item.step ?? (max - min > 2 ? 1 : 0.05);
        const raw = o.values[item.key];
        const val = typeof raw === 'number' && Number.isFinite(raw) ? raw : min;

        const input = make('input', 'ms-slider');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(val);
        input.setAttribute('aria-labelledby', label.id);

        const readout = make('span', 'ms-slider__value', fmtSliderValue(val, step));
        input.addEventListener('input', () => {
          const n = input.valueAsNumber;
          readout.textContent = fmtSliderValue(n, step);
          o.onChange(item.key, n);
        });
        control.appendChild(input);
        control.appendChild(readout);
        break;
      }

      case 'toggle': {
        let on = o.values[item.key] === true;
        const sw = make('button', 'ms-toggle');
        sw.type = 'button';
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        sw.setAttribute('aria-labelledby', label.id);
        sw.appendChild(make('span', 'ms-toggle__state ms-toggle__state--on', 'ON'));
        sw.appendChild(make('span', 'ms-toggle__state ms-toggle__state--off', 'OFF'));
        sw.appendChild(make('span', 'ms-toggle__lever'));
        sw.addEventListener('click', () => {
          on = !on;
          sw.setAttribute('aria-checked', on ? 'true' : 'false');
          o.onChange(item.key, on);
        });
        control.appendChild(sw);
        break;
      }

      case 'select': {
        const options = item.options ?? [];
        const raw = o.values[item.key];
        const current = typeof raw === 'string' ? raw : '';
        let initial = options.findIndex((opt) => opt.value === current);
        if (initial < 0) initial = 0;

        const seg = div('ms-seg');
        seg.setAttribute('role', 'radiogroup');
        seg.setAttribute('aria-labelledby', label.id);
        const optEls: HTMLButtonElement[] = [];
        for (const opt of options) {
          const b = make('button', 'ms-seg__opt', opt.label);
          b.type = 'button';
          b.setAttribute('role', 'radio');
          seg.appendChild(b);
          optEls.push(b);
        }
        if (optEls.length > 0) {
          let last = initial;
          rovingGroup(optEls, initial, 'aria-checked', (i) => {
            if (i !== last) {
              last = i;
              o.onChange(item.key, options[i]!.value);
            }
          });
        }
        control.appendChild(seg);
        break;
      }

      case 'keybind': {
        const raw = o.values[item.key];
        const currentCode = typeof raw === 'string' ? raw : '';
        const kb = make('button', 'ms-kbd', prettyKey(currentCode));
        kb.type = 'button';
        kb.setAttribute('aria-labelledby', label.id);
        kb.title = 'Click, then press a key';

        let listening = false;
        const finish = (code: string): void => {
          listening = false;
          kb.classList.remove('ms-kbd--listening');
          kb.textContent = prettyKey(code);
          o.onChange(item.key, code);
        };
        const cancel = (prevText: string): void => {
          listening = false;
          kb.classList.remove('ms-kbd--listening');
          kb.textContent = prevText;
        };

        kb.addEventListener('click', () => {
          if (listening) return;
          listening = true;
          const prevText = kb.textContent ?? '';
          kb.classList.add('ms-kbd--listening');
          kb.textContent = 'PRESS KEY…';

          if (o.onRebind) {
            o.onRebind(item.key, (code: string) => {
              if (listening) finish(code);
            });
          } else {
            // Fallback: capture the next keydown ourselves.
            let removed = false;
            const teardown = (): void => {
              if (removed) return;
              removed = true;
              window.removeEventListener('keydown', onKey, true);
              if (cancelFallbackRebind === abortListening) cancelFallbackRebind = null;
            };
            const onKey = (e: KeyboardEvent): void => {
              e.preventDefault();
              e.stopPropagation();
              teardown();
              if (e.code === 'Escape') cancel(prevText);
              else finish(e.code);
            };
            // Fully resets THIS row (listener + flag + button text/style) —
            // used both when another row starts listening and on dispose.
            const abortListening = (): void => {
              teardown();
              cancel(prevText);
            };
            if (cancelFallbackRebind) cancelFallbackRebind();
            cancelFallbackRebind = abortListening;
            window.addEventListener('keydown', onKey, true);
          }
        });
        control.appendChild(kb);
        break;
      }
    }
    return row;
  }

  return { el, dispose: shell.dispose };
}

// ---------------------------------------------------------------------------
// PAUSE MENU
// ---------------------------------------------------------------------------

export function createPauseMenu(o: {
  stats: { wave: number; kills: number; req: number };
  onResume: () => void;
  onSettings: () => void;
  onHelp: () => void;
  onRestart: () => void;
  onQuit: () => void;
}): ScreenHandle {
  const shell = screenShell('pause-screen', 'Paused', o.onResume);
  const { el } = shell;

  const panel = div('ms-panel pause-panel');
  el.appendChild(panel);

  panel.appendChild(make('h2', 'pause-title', 'STAND EASY'));
  panel.appendChild(stamp('HALT', true));

  const stats = div('pause-stats');
  stats.appendChild(make('span', 'ms-chip', 'WAVE ' + o.stats.wave));
  stats.appendChild(make('span', 'ms-chip', 'KILLS ' + fmtNum(o.stats.kills)));
  stats.appendChild(make('span', 'ms-chip', 'REQ ' + fmtNum(o.stats.req)));
  panel.appendChild(stats);

  panel.appendChild(chit('Resume', 'ms-btn ms-btn--primary', o.onResume));
  panel.appendChild(chit('Settings', 'ms-btn', o.onSettings));
  panel.appendChild(chit('Field Manual', 'ms-btn', o.onHelp));
  panel.appendChild(chit('Restart Battle', 'ms-btn', o.onRestart));
  panel.appendChild(chit('Abandon Post', 'ms-btn ms-btn--danger', o.onQuit));

  return { el, dispose: shell.dispose };
}

// ---------------------------------------------------------------------------
// GAME OVER
// ---------------------------------------------------------------------------

export function createGameOverScreen(o: {
  victory: boolean;
  stats: {
    waves: number;
    kills: number;
    losses: number;
    daysHeld: number;
    score: number;
    highScore: number;
    seed: string;
  };
  memorial: Array<{ name: string; rank: string; kind: string; wave: number; epitaph: string; deeds?: string[]; wavesServed?: number }>;
  letter: string | null;
  onRestart: () => void;
  onMenu: () => void;
  onContinueEndless?: () => void;
}): ScreenHandle {
  const variant = o.victory ? 'gameover-screen--victory' : 'gameover-screen--defeat';
  const shell = screenShell(
    'gameover-screen ' + variant,
    o.victory ? 'Victory' : 'Defeat',
    o.onMenu,
  );
  const { el } = shell;

  const col = div('go-col');
  el.appendChild(col);

  col.appendChild(
    make('h1', 'go-title', o.victory ? 'RELIEVED' : 'THE LINE IS BROKEN'),
  );
  col.appendChild(
    div('go-sub', o.victory ? 'THE LINE HELD' : 'FLANDERS, 1916'),
  );

  // --- casualty return document ---
  const docWrap = div('torn-wrap casualty-doc-wrap');
  const doc = div('ms-panel torn casualty-doc');
  docWrap.appendChild(doc);

  const docHead = div('casualty-doc__head');
  docHead.appendChild(
    make('h2', 'casualty-doc__title', o.victory ? 'RETURN OF SERVICE' : 'CASUALTY RETURN'),
  );
  const isRecord = o.stats.score > 0 && o.stats.score >= o.stats.highScore;
  docHead.appendChild(
    isRecord ? stamp('NEW RECORD') : stamp('PASSED BY CENSOR', o.victory),
  );
  doc.appendChild(docHead);

  const statRow = (label: string, value: string): HTMLDivElement => {
    const r = div('casualty-row');
    r.appendChild(make('span', 'casualty-row__label', label));
    r.appendChild(make('span', 'casualty-row__dots'));
    r.appendChild(make('span', 'casualty-row__value', value));
    return r;
  };
  doc.appendChild(statRow('Days Held', String(o.stats.daysHeld)));
  doc.appendChild(statRow('Waves Repelled', String(o.stats.waves)));
  doc.appendChild(statRow('Enemy Accounted For', fmtNum(o.stats.kills)));
  doc.appendChild(statRow('Our Losses', fmtNum(o.stats.losses)));
  doc.appendChild(statRow('Final Reckoning', fmtNum(o.stats.score)));
  doc.appendChild(statRow('Regimental Best', fmtNum(o.stats.highScore)));
  doc.appendChild(statRow('Sector Code', o.stats.seed.toUpperCase()));
  col.appendChild(docWrap);

  // --- letter home: a folded note that unfolds on click ---
  if (o.letter !== null && o.letter.length > 0) {
    const letterText = o.letter;
    const holder = div('go-letter');
    const fold = make('button', 'letter-fold', '✉ A letter home — unfold');
    fold.type = 'button';

    const open = div('go-letter__open');
    open.hidden = true;
    const paper = div('letter-paper ms-scroll');
    const parts = letterText.split(/\n+/);
    for (const p of parts) {
      const t = p.trim();
      if (t.length > 0) paper.appendChild(make('p', undefined, t));
    }
    const foldAway = chit('Fold away', 'ms-btn ms-btn--ghost ms-btn--small', () => {
      open.hidden = true;
      fold.hidden = false;
      fold.focus();
    });
    open.appendChild(paper);
    open.appendChild(foldAway);

    fold.addEventListener('click', () => {
      fold.hidden = true;
      open.hidden = false;
      foldAway.focus();
    });

    holder.appendChild(fold);
    holder.appendChild(open);
    col.appendChild(holder);
  }

  // --- memorial wall ---
  if (o.memorial.length > 0) {
    const memorial = div('memorial');
    memorial.setAttribute('role', 'group');
    memorial.setAttribute('aria-label', 'Roll of honour');
    memorial.appendChild(make('h2', 'memorial__title', 'ROLL OF HONOUR'));

    const viewport = div('memorial__viewport ms-scroll');
    const track = div('memorial__track');
    viewport.appendChild(track);
    memorial.appendChild(viewport);

    const buildCopy = (hiddenCopy: boolean): HTMLDivElement => {
      const copy = div('memorial__copy');
      if (hiddenCopy) copy.setAttribute('aria-hidden', 'true');
      for (const m of o.memorial) {
        const honoured = (m.deeds?.length ?? 0) > 0 || (m.wavesServed ?? 0) >= 4;
        const entry = div('memorial-entry' + (honoured ? ' memorial-entry--honoured' : ''));
        const nameLine = div('memorial-entry__name');
        const poppyL = make('span', 'poppy');
        poppyL.setAttribute('aria-hidden', 'true');
        const poppyR = make('span', 'poppy');
        poppyR.setAttribute('aria-hidden', 'true');
        nameLine.appendChild(poppyL);
        nameLine.appendChild(
          make('span', undefined, m.rank.toUpperCase() + ' ' + m.name.toUpperCase()),
        );
        nameLine.appendChild(poppyR);
        entry.appendChild(nameLine);
        const service = m.wavesServed && m.wavesServed > 0
          ? m.kind + ' — fell wave ' + m.wave + ', after ' + m.wavesServed + ' in the line'
          : m.kind + ' — fell, wave ' + m.wave;
        entry.appendChild(make('div', 'memorial-entry__line', service));
        // The decorated are named for their deeds — a distinct honour on the wall.
        if (m.deeds && m.deeds.length > 0) {
          entry.appendChild(
            make('div', 'memorial-entry__deeds', '✠ Mentioned in despatches — ' + m.deeds.join(', ')),
          );
        }
        entry.appendChild(
          make('div', 'memorial-entry__epitaph', '“' + m.epitaph + '”'),
        );
        copy.appendChild(entry);
      }
      return copy;
    };

    const scrolls = o.memorial.length > 4;
    track.appendChild(buildCopy(false));
    if (scrolls) {
      track.appendChild(buildCopy(true));
      track.style.animationDuration = Math.max(14, o.memorial.length * 3) + 's';
    } else {
      memorial.classList.add('memorial--static');
    }
    col.appendChild(memorial);
  }

  // --- action chits ---
  const actions = div('go-actions');
  actions.appendChild(chit('Once More', 'ms-btn ms-btn--primary', o.onRestart));
  if (o.onContinueEndless) {
    actions.appendChild(chit('Fight On — Endless', 'ms-btn', o.onContinueEndless));
  }
  actions.appendChild(chit('Return to Billets', 'ms-btn ms-btn--ghost', o.onMenu));
  col.appendChild(actions);

  return { el, dispose: shell.dispose };
}

// ---------------------------------------------------------------------------
// HELP / FIELD MANUAL
// ---------------------------------------------------------------------------

export function createHelpOverlay(o: {
  sections: Array<{ title: string; html: string }>;
  onClose: () => void;
}): ScreenHandle {
  const shell = screenShell('help-screen', 'Field manual', o.onClose);
  const { el } = shell;

  const book = div('ms-panel help-book');
  el.appendChild(book);

  const head = div('help-head');
  head.appendChild(make('h2', 'help-title', 'FIELD MANUAL'));
  head.appendChild(stamp('FOR OFFICIAL USE', true));
  book.appendChild(head);

  const tabs = div('settings-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Manual sections');
  book.appendChild(tabs);

  const body = div('help-body ms-scroll');
  body.tabIndex = 0; // scrollable region must be keyboard-reachable
  body.setAttribute('role', 'tabpanel');
  book.appendChild(body);

  const tabEls: HTMLButtonElement[] = [];
  for (let i = 0; i < o.sections.length; i++) {
    const tab = make('button', 'settings-tab', o.sections[i]!.title);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tabs.appendChild(tab);
    tabEls.push(tab);
  }
  if (tabEls.length > 0) {
    rovingGroup(tabEls, 0, 'aria-selected', (i) => {
      // Section html comes from the game's own static content — trusted.
      body.innerHTML = o.sections[i]!.html;
      body.scrollTop = 0;
    });
  }

  const foot = div('help-foot');
  foot.appendChild(chit('Close Manual', 'ms-btn ms-btn--primary', o.onClose));
  book.appendChild(foot);

  return { el, dispose: shell.dispose };
}

// ---------------------------------------------------------------------------
// INTEL REPORT (pre-wave briefing)
// ---------------------------------------------------------------------------

export function createIntelReport(o: {
  wave: number;
  date: string;
  title: string;
  rows: Array<{ icon: string; label: string; detail: string }>;
  weatherLine: string;
  adviceLine: string;
  onBegin: () => void;
  beginLabel: string;
}): ScreenHandle {
  // The only way out of a briefing is forward.
  const shell = screenShell('intel-screen', 'Intelligence report', o.onBegin);
  const { el } = shell;

  const wrap = div('torn-wrap');
  const sheet = div('ms-panel torn intel-sheet ms-scroll');
  wrap.appendChild(sheet);
  el.appendChild(wrap);

  let delay = 0.15;
  const reveal = (node: HTMLElement): HTMLElement => {
    node.classList.add('type-in');
    node.style.animationDelay = delay.toFixed(2) + 's';
    delay += 0.13;
    return node;
  };

  const head = div('intel-head');
  const org = div('intel-org');
  org.appendChild(make('div', undefined, 'FIELD INTELLIGENCE SUMMARY'));
  org.appendChild(make('div', undefined, 'SECOND ARMY · FLANDERS'));
  head.appendChild(org);
  const right = div();
  right.appendChild(stamp('SECRET'));
  right.appendChild(make('div', 'intel-date', o.date));
  head.appendChild(right);
  sheet.appendChild(head);

  sheet.appendChild(reveal(div('intel-wave', 'ASSAULT EXPECTED — WAVE ' + o.wave)));
  sheet.appendChild(reveal(make('h2', 'intel-title', o.title)));

  for (const row of o.rows) {
    const r = div('intel-row');
    r.appendChild(make('span', 'intel-row__icon', row.icon));
    r.appendChild(make('span', 'intel-row__label', row.label));
    r.appendChild(make('span', 'intel-row__detail', row.detail));
    sheet.appendChild(reveal(r));
  }

  const dividerEl = div('ms-divider', 'MET. SECTION');
  sheet.appendChild(reveal(dividerEl));
  sheet.appendChild(reveal(div('intel-weather', o.weatherLine)));
  sheet.appendChild(reveal(div('intel-advice', o.adviceLine)));

  sheet.appendChild(chit(o.beginLabel, 'ms-btn ms-btn--primary intel-begin', o.onBegin));

  return { el, dispose: shell.dispose };
}

// ---------------------------------------------------------------------------
// LETTER OVERLAY
// ---------------------------------------------------------------------------

export function createLetterOverlay(o: {
  text: string;
  signature: string;
  onClose: () => void;
}): ScreenHandle {
  const shell = screenShell('letter-screen', 'A letter', o.onClose);
  const { el } = shell;

  const paper = div('letter-paper ms-scroll');
  const parts = o.text.split(/\n+/);
  for (const p of parts) {
    const t = p.trim();
    if (t.length > 0) paper.appendChild(make('p', undefined, t));
  }
  paper.appendChild(div('letter-sig', o.signature));
  el.appendChild(paper);

  el.appendChild(chit('Read', 'ms-btn ms-btn--primary', o.onClose));

  return { el, dispose: shell.dispose };
}
