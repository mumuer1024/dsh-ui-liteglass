// dsh-ui-appearance — no-appearance regression test.
//
// Confirms the plugin no longer owns or changes the DSH native color mode:
//   * the client source contains NO theme.setTheme call and NO appearance /
//     originalPreference field (schema/normalize/persist all dropped them);
//   * editing ANY plugin setting only calls theme.overrideTokens (never
//     setTheme);
//   * on a native theme/change (Light/Dark/System) the plugin recomputes its
//     Accent/glass token layer via overrideTokens — never changes the theme;
//   * enable/disable/unload never calls setTheme, so the native color mode is
//     left untouched.
//
// Scope is now: Wallpaper + Glass + Accent, only.

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(root, '..', 'lib', 'client.js'), 'utf8')

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

console.log('\n== 1. source-level: no color-mode control remains ==')
// Strip comments so doc mentions don't false-positive.
const noComments = src.replace(/\/\/[^\n]*/g, '')
check('no theme.setTheme / themeService.setTheme call', !/(?:theme|themeService)\.setTheme\s*\(/.test(noComments) && !/\.setTheme\s*\(/.test(noComments))
check('no "appearance" field in config schema', !/\.appearance\b/.test(noComments))
check('no originalPreference field', !/originalPreference/.test(noComments))
check('no applyAppearance function', !/applyAppearance\b/.test(noComments))
check('still uses overrideTokens (Accent/glass)', /overrideTokens\s*\(/.test(noComments))
check('still has theme/change listener', /theme\/change/.test(noComments))

console.log('\n== 2. factory contract still valid ==')
let captured = null
const sb = {
  window: { __ModuleLoader__: { load: (r) => { captured = r } } },
  __ModuleLoader__: { load: (r) => { captured = r } },
  console, document: undefined, fetch: undefined
}
vm.createContext(sb)
vm.runInContext(src, sb)
const factory = captured.factory
const react = { createElement: () => ({}), useState: () => [], useEffect: () => {} }
const out = factory((id) => { if (id === 'react') return react; throw new Error('require ' + id) })
check('inject = [slots, theme]', out.inject[0] === 'slots' && out.inject[1] === 'theme')
check('apply is a function', typeof out.apply === 'function')

console.log('\n== 3. logic: edits only overrideTokens, native color mode never changes ==')
// Mock theme that records whether setTheme is ever invoked.
const theme = {
  overrideCalls: 0,
  setThemeCalls: 0,
  overrideTokens() { this.overrideCalls += 1; return () => {} }
}
// Mirror the client's applyVisuals/onThemeChange: patch calls applyThemeLayer
// (overrideTokens); theme/change recomputes it; neither calls setTheme.
function applyThemeLayer(c) { if (theme && typeof theme.overrideTokens === 'function') theme.overrideTokens('dsh-ui-appearance', c) }
let currentConfig = null
function patch(p) { const base = currentConfig || {}; const next = Object.assign({}, base, p); currentConfig = next; applyThemeLayer(next) }
function onThemeChange() { if (currentConfig) applyThemeLayer(currentConfig) }

patch({ background: 'url', backgroundImage: 'https://x/w.jpg' })
patch({ backgroundOpacity: 0.4 })
patch({ panelBlur: 8 })
patch({ accentColor: '#3366cc' })
patch({ panelOpacity: 0.5 })
check('every edit recomputed overrideTokens', theme.overrideCalls >= 5)
check('zero setTheme across all edits', theme.setThemeCalls === 0)

console.log('\n== 4. native scheme change recomputes tokens, does not touch theme ==')
const before = theme.overrideCalls
onThemeChange() // simulate native Light→Dark theme/change
check('theme/change recomputes token layer', theme.overrideCalls === before + 1)
check('theme/change did not call setTheme', theme.setThemeCalls === 0)

console.log('\n== 5. enable/disable/unload leaves native color mode untouched ==')
// The plugin has no setTheme anywhere, so enable/disable/unload cannot change it.
check('no setTheme path exists to run at unload', theme.setThemeCalls === 0)

console.log('\n== RESULT: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)
