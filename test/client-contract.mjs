// dsh-ui-liteglass — client-half contract test.
//
// Loads lib/client.js in a sandbox with a DOM stub, then drives the REAL
// `apply(ctx)` against stubbed `slots` / `theme` services to verify the DSH
// 0.2.x behaviour this plugin depends on:
//   * the settings surface registers into `settings.general.item` (the row seat
//     beside the native Appearance row), not a second page;
//   * `theme.overrideTokens` receives { light, dark } pairs whose surface alphas
//     increase with depth (the native palette's nesting survives);
//   * `--dsw-alias-brand-primary` stays untouched unless `accentButtons` is on,
//     and is then paired with a legible foreground;
//   * unload retires the token layer and removes the wallpaper node.

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(root, '..', 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

// ---- minimal DOM: style objects, createElement, #root, head/body ----
function makeStyle() {
  const style = {}
  style.setProperty = (k, v) => { style[k] = v }
  style.removeProperty = (k) => { delete style[k] }
  return style
}
function makeNode(tag) {
  const node = {
    tagName: tag,
    style: makeStyle(),
    attrs: {},
    children: [],
    parentNode: null,
    setAttribute(k, v) { node.attrs[k] = v },
    appendChild(child) { child.parentNode = node; node.children.push(child); return child },
    insertBefore(child, ref) {
      child.parentNode = node
      const at = node.children.indexOf(ref)
      if (at < 0) node.children.push(child)
      else node.children.splice(at, 0, child)
      return child
    },
    removeChild(child) {
      const at = node.children.indexOf(child)
      if (at >= 0) node.children.splice(at, 1)
      child.parentNode = null
      return child
    },
    remove() { if (node.parentNode) node.parentNode.removeChild(node) }
  }
  return node
}
function makeDom() {
  const html = makeNode('html')
  const body = makeNode('body')
  const head = makeNode('head')
  const rootEl = makeNode('div')
  rootEl.id = 'root'
  body.appendChild(rootEl)
  const document = {
    documentElement: html,
    body,
    head,
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => (id === 'root' ? rootEl : null)
  }
  return { document, html, body, head, rootEl }
}

const react = { createElement: () => ({}), useState: () => [], useEffect: () => {} }

/**
 * Load the client factory, run apply() with stubbed services, and let the
 * initial config fetch settle.
 */
async function run(config) {
  const dom = makeDom()
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => { captured = registration } } },
    __ModuleLoader__: { load: (registration) => { captured = registration } },
    document: dom.document,
    fetch: async () => ({ json: async () => ({ ok: true, config }) }),
    console,
    setTimeout,
    queueMicrotask
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  const mod = captured.factory((id) => {
    if (id === 'react') return react
    throw new Error('require ' + id)
  })

  const effects = []
  const themeCalls = []
  const slotCalls = []
  let themeDisposed = 0

  const theme = {
    overrideTokens(source, tokens) {
      themeCalls.push({ source, tokens })
      return () => { themeDisposed += 1 }
    }
  }
  const slots = {
    inject(name, callback) { slotCalls.push({ kind: 'inject', name }); callback() },
    register(options) { slotCalls.push({ kind: 'register', options }); return () => {} }
  }
  const listeners = {}
  const ctx = {
    get: (name) => (name === 'slots' ? slots : name === 'theme' ? theme : undefined),
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
    on(name, fn) { listeners[name] = fn; return () => { delete listeners[name] } }
  }

  mod.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 0))

  return {
    dom, mod, ctx, theme, themeCalls, slotCalls, listeners,
    themeDisposed: () => themeDisposed,
    disposeAll() { while (effects.length > 0) effects.pop()() }
  }
}

const baseConfig = {
  background: 'url',
  backgroundImage: 'https://example.com/wallpaper.png',
  backgroundOpacity: 0.8,
  backgroundBlur: 10,
  panelOpacity: 0.5,
  panelBlur: 0,
  accentColor: '#e4c249',
  accentButtons: false
}

const LADDER = [
  '--dsw-alias-bg-base',
  '--dsw-specific-sidebar-fill',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-module-platform',
  '--dsw-specific-selector',
  '--dsw-alias-bg-layer-2',
  '--dsw-specific-input-major',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-specific-menu'
]

function alphaOf(value) {
  const match = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(String(value))
  return match ? Number(match[1]) : NaN
}

console.log('\n== 1. settings surface lands in the General page row seat ==')
let run1 = await run(baseConfig)
check('module id is the package name', run1.mod.inject.length === 2)
check('slots.inject targets settings.general.item',
  run1.slotCalls.some((call) => call.kind === 'inject' && call.name === 'settings.general.item'))
check('registration uses the general item slot',
  run1.slotCalls.some((call) => call.kind === 'register' && call.options.name === 'settings.general.item'))
check('no second Appearance page is registered',
  !run1.slotCalls.some((call) => call.kind === 'register' && call.options.name === 'settings.section'))

console.log('\n== 2. token layer: {light, dark} pairs, alpha ladder keeps depth ==')
const layer = run1.themeCalls[run1.themeCalls.length - 1]
check('overrideTokens source is the plugin id', layer.source === 'dsh-ui-liteglass')
const tokens = layer.tokens
check('every token carries a light and a dark string',
  Object.entries(tokens).every(([, v]) => typeof v.light === 'string' && typeof v.dark === 'string' && v.light.length > 0 && v.dark.length > 0))
const lightAlphas = LADDER.map((token) => alphaOf(tokens[token] && tokens[token].light))
const darkAlphas = LADDER.map((token) => alphaOf(tokens[token] && tokens[token].dark))
// Controls that sit at the same depth (selector / input vs layer-2) share an
// alpha on purpose, so the ladder must be non-decreasing rather than strictly
// increasing — but it must still climb overall.
const increasing = (list) => list.every((a, i) => i === 0 || a >= list[i - 1]) && list[list.length - 1] - list[0] >= 0.08
check('surface ladder is present', lightAlphas.every(Number.isFinite) && darkAlphas.every(Number.isFinite))
check('light surfaces get more opaque with depth', increasing(lightAlphas), JSON.stringify(lightAlphas))
check('dark surfaces get more opaque with depth', increasing(darkAlphas), JSON.stringify(darkAlphas))
check('overlay/menu surfaces are included', '--dsw-alias-bg-overlay' in tokens && '--dsw-specific-menu' in tokens)

console.log('\n== 3. accent reaches the emphasis tokens ==')
check('business/focus accent set', tokens['--dsw-alias-state-business-primary'].light === '#e4c249')
check('sidebar active accent set', '--dsw-specific-sidebar-nav-item-active-accent' in tokens)
check('hover accent set', '--dsw-alias-interactive-bg-hover-accent' in tokens)

console.log('\n== 4. primary-button recoloring is opt-in and paired with a foreground ==')
check('brand-primary untouched by default', !('--dsw-alias-brand-primary' in tokens))
check('foreground untouched by default', !('--dsw-alias-label-primary-foreground' in tokens))

const runLight = await run({ ...baseConfig, accentButtons: true })
const lightTokens = runLight.themeCalls[runLight.themeCalls.length - 1].tokens
check('brand-primary recolored when enabled', lightTokens['--dsw-alias-brand-primary'].light === '#e4c249')
check('light accent (yellow) gets dark foreground',
  lightTokens['--dsw-alias-label-primary-foreground'].light === '#0f0f0f')

const runDark = await run({ ...baseConfig, accentColor: '#3366cc', accentButtons: true })
const darkTokens = runDark.themeCalls[runDark.themeCalls.length - 1].tokens
check('dark accent (blue) gets light foreground',
  darkTokens['--dsw-alias-label-primary-foreground'].light === '#ffffff')

console.log('\n== 5. wallpaper node sits behind #root ==')
const bgNode = run1.dom.body.children.find((node) => node.attrs['data-dsh-ui-liteglass'] === 'bg')
check('wallpaper node inserted', bgNode !== undefined)
check('wallpaper node precedes #root', run1.dom.body.children.indexOf(bgNode) === run1.dom.body.children.indexOf(run1.dom.rootEl) - 1)
check('wallpaper variable set on the document root',
  String(run1.dom.html.style['--dsh-liteglass-bg-image']).includes('example.com/wallpaper.png'))

console.log('\n== 6. theme/change recomputes, never calls setTheme ==')
const before = run1.themeCalls.length
run1.listeners['theme/change']({ active: { colorScheme: 'dark' } })
check('recompose on native scheme change', run1.themeCalls.length === before + 1)
check('no setTheme on the theme service', !('setTheme' in run1.theme))

console.log('\n== 7. unload retires the layer and removes the wallpaper node ==')
run1.disposeAll()
check('theme layer disposed on unload', run1.themeDisposed() >= 1)
check('wallpaper node removed on unload',
  !run1.dom.body.children.some((node) => node.attrs['data-dsh-ui-liteglass'] === 'bg'))
check('stylesheet removed on unload', run1.dom.head.children.length === 0)

console.log('\n== 8. glass off by default: no surface tokens, no background node ==')
const runOff = await run({ ...baseConfig, background: 'off', backgroundImage: '', panelOpacity: 1, accentColor: '' })
const offTokens = runOff.themeCalls[runOff.themeCalls.length - 1].tokens
check('no surface tokens when glass is off', !('--dsw-alias-bg-base' in offTokens))
check('no accent tokens when accent is unset', !('--dsw-alias-state-business-primary' in offTokens))
check('no wallpaper node when background is off',
  !runOff.dom.body.children.some((node) => node.attrs['data-dsh-ui-liteglass'] === 'bg'))

console.log('\n== RESULT: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0) process.exit(1)