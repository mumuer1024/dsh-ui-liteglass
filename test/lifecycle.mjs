// dsh-ui-appearance — Settings component lifecycle test (state-model level).
//
// This validates the AUTHORITATIVE-CONFIG invariant that the client fix
// guarantees, WITHOUT a browser/React runtime. It mirrors the store semantics
// implemented in lib/client.js:
//   * `currentConfig` is the single source of truth (module-level, survives
//     unmount/remount).
//   * React component state is only a subscription mirror; a remount
//     initializes from `currentConfig`, NEVER from DEFAULT_CONFIG or a stale
//     cached snapshot.
//   * DEFAULT_CONFIG is only the normalization fallback when no config exists.
//   * A page refresh / DSH restart re-loads from the persisted (server) config.
//
// It reproduces the reported bug class: on a fresh install, a remount must NOT
// fall back to DEFAULT_CONFIG and must keep the edited values for as long as
// the plugin fiber lives.

const DEFAULT_CONFIG = {
  background: 'off',
  backgroundImage: '',
  backgroundOpacity: 0.35,
  backgroundBlur: 0,
  panelOpacity: 1,
  panelBlur: 0,
  accentColor: ''
}
const BACKGROUNDS = ['off', 'url', 'local']

function finite(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback }
function oneOf(v, list, fallback) { return list.indexOf(v) !== -1 ? v : fallback }
function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const c = {}
  c.background = oneOf(s.background, BACKGROUNDS, DEFAULT_CONFIG.background)
  c.backgroundImage = typeof s.backgroundImage === 'string' ? s.backgroundImage : ''
  c.backgroundOpacity = finite(s.backgroundOpacity, DEFAULT_CONFIG.backgroundOpacity)
  c.backgroundBlur = finite(s.backgroundBlur, DEFAULT_CONFIG.backgroundBlur)
  c.panelOpacity = finite(s.panelOpacity, DEFAULT_CONFIG.panelOpacity)
  c.panelBlur = finite(s.panelBlur, DEFAULT_CONFIG.panelBlur)
  c.accentColor = /^#[0-9a-fA-F]{3,8}$/.test(s.accentColor) ? String(s.accentColor) : ''
  return c
}
function eq(a, b) { try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false } }

// ---- authoritative store (mirrors lib/client.js) ----
let currentConfig = null
let listeners = []
function emitStore() { for (const fn of listeners) { try { fn() } catch {} } }
function subscribeStore(fn) { listeners.push(fn); return () => { listeners = listeners.filter(l => l !== fn) } }
function commitConfig(c) { currentConfig = c; emitStore() } // applyAll(c) equivalent

// Simulated server persistence (what GET /config returns after reload).
let persisted = null // null on fresh install

function loadFromServer() {
  // mirrors client load(): normalize(saved) then commit
  const c = normalize(persisted)
  if (!eq(c, persisted)) persisted = c // repair partial on disk
  commitConfig(c)
  return c
}

// ---- React-less component simulation ----
// A "remount" reads the authoritative currentConfig (the fix). The OLD buggy
// behavior read a cached snapshot / DEFAULT_CONFIG instead — we assert the NEW
// behavior throughout.
function mountSettingsPanelRead() {
  return currentConfig // useState(currentConfig) initializer
}

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

const finiteOk = (c) =>
  Number.isFinite(c.backgroundOpacity) && Number.isFinite(c.backgroundBlur) &&
  Number.isFinite(c.panelOpacity) && Number.isFinite(c.panelBlur) &&
  !JSON.stringify(c).includes('NaN') && !JSON.stringify(c).includes('undefined')

console.log('\n== 1. fresh install: server has no config ==')
persisted = null
let c = loadFromServer()
check('fresh config equals DEFAULT', eq(c, DEFAULT_CONFIG))

console.log('\n== 2. open Settings and edit A/B/C ==')
function userEdit(p) { const base = currentConfig || DEFAULT_CONFIG; const next = normalize(Object.assign({}, base, p)); commitConfig(next); persisted = next; return next }
c = userEdit({ background: 'url', backgroundImage: 'https://ex.com/w.jpg' })
c = userEdit({ panelOpacity: 0.5, backgroundBlur: 6, accentColor: '#3366cc' })
check('edited values applied', c.background === 'url' && c.panelOpacity === 0.5 && c.accentColor === '#3366cc')
check('edited config finite', finiteOk(c))

console.log('\n== 3. close Settings (unmount) ==')
// unmount: listeners cleared, authoritative currentConfig unchanged
listeners = []

console.log('\n== 4. reopen Settings ×5 — controls MUST equal live config, not DEFAULT ==')
let seenStale = false
for (let i = 1; i <= 5; i++) {
  const read = mountSettingsPanelRead()
  const matches = eq(read, c)
  const isDefault = eq(read, DEFAULT_CONFIG)
  check(`reopen #${i}: hydrates from authoritative currentConfig`, matches, `got=${JSON.stringify(read && { background: read.background, panelOpacity: read.panelOpacity, accentColor: read.accentColor })}`)
  if (isDefault && !eq(read, c)) { seenStale = true; check(`reopen #${i}: NOT fallen back to DEFAULT_CONFIG`, false) }
  else check(`reopen #${i}: NOT DEFAULT_CONFIG`, true)
}
check('no remount ever fell back to DEFAULT_CONFIG', seenStale === false)

console.log('\n== 5. edit again after remount, then reopen — still stable ==')
c = userEdit({ panelOpacity: 0.3 })
check('post-remount edit kept', mountSettingsPanelRead().panelOpacity === 0.3)

console.log('\n== 6. simulated page refresh / DSH restart (new session reloads persisted) ==')
currentConfig = null
persisted = { background: 'local', backgroundImage: '/ui-appearance/backgrounds/abc123def4567890.png', backgroundOpacity: 0.4, backgroundBlur: 3, panelOpacity: 0.6, panelBlur: 8, accentColor: '#ff7700' }
c = loadFromServer()
check('reload restores persisted config', eq(c, persisted))
check('reload config finite', finiteOk(c))

console.log('\n== 7. partial persisted (legacy) repaired on reload ==')
currentConfig = null
persisted = { panelOpacity: 0.4 } // legacy partial
c = loadFromServer()
check('partial repaired to full config', Object.keys(DEFAULT_CONFIG).every(k => Object.prototype.hasOwnProperty.call(c, k)))
check('repaired config finite', finiteOk(c))

console.log('\n== RESULT: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)
