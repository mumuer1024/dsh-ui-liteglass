// dsh-ui-liteglass — web client half (minimal, no build step).
//
// Authored in the client-modules module-table format (mirrors the installed
// @feiyang666/dsh-usage-plugin). The runner wraps `apply(ctx)` with a guarded
// ctx: service access is gated by the returned `inject` (`slots`, `theme`);
// `theme.overrideTokens` source is FORCED to this package id and its disposer
// is auto-hung on the fiber (unload restores), so we never impersonate another
// source's override layer.
//
// Capabilities (only these):
//   1. Wallpaper  — url | local(server upload) | off; opacity + blur.
//   2. Glass      — translucent surfaces via theme.overrideTokens.
//   3. Accent     — recolor native highlight/selected/link/button/focus tokens.
//
// Color mode (Light/Dark/System) is owned ENTIRELY by DSH native settings. This
// plugin never calls theme.setTheme and never persists any appearance field. It
// only listens to theme/change to recompute its Accent/glass token layer for the
// current active color scheme.
//
// STATE MODEL (the single authoritative client source of truth):
//   * `currentConfig` (module-level) is ALWAYS a fully-normalized config —
//     every field present and every number finite. Nothing may hold null /
//     partial / undefined values after `normalize()`.
//   * Server config is treated as partial; it is merged over DEFAULT_CONFIG,
//     never trusted to be complete.
//   * All user edits go through `patch()` which reads `currentConfig` (not the
//     React closure), so rapid / concurrent field updates never drop fields.

window.__ModuleLoader__.load({
  id: 'dsh-ui-liteglass',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    // ---- authoritative state ----
    var ctxRef = null // guarded ctx captured in apply()
    var bgEl = null // background layer element
    var currentConfig = null // always fully-normalized; THE single source of truth

    // Tiny pub/sub so React re-renders from `currentConfig` whenever it
    // changes. React component state is only a subscription mirror — never an
    // independent config — so unmount/remount always hydrates from the live
    // authoritative config, never from a cached snapshot or DEFAULT_CONFIG.
    var storeListeners = []
    var storeVersion = 0
    function emitStore() {
      storeVersion += 1
      for (var i = 0; i < storeListeners.length; i += 1) {
        try { storeListeners[i]() } catch (e) { /* non-fatal */ }
      }
    }
    function subscribeStore(fn) {
      storeListeners.push(fn)
      return function () {
        storeListeners = storeListeners.filter(function (l) { return l !== fn })
      }
    }

    var DEFAULT_CONFIG = {
      background: 'off',
      backgroundImage: '',
      backgroundOpacity: 0.35,
      backgroundBlur: 0,
      panelOpacity: 1, // 1 = fully opaque = native (plugin off by default)
      panelBlur: 0,
      accentColor: ''
    }
    var BACKGROUNDS = ['off', 'url', 'local']

    // ---- injected stylesheet (namespaced with --dsh-liteglass-*) ----
    // NOTE: panel backdrop-filter is DISABLED — applying backdrop-filter to the
    // column containers created a containing block / stacking context that
    // broke fixed-position overlays (the Settings page shifted into the
    // sidebar). Glass is achieved via translucent token surfaces + a blurred
    // background layer only. Re-enable backdrop-filter only on a verified-safe
    // inner container, never on the three columns.
    var CSS = [
      ':root{--dsh-liteglass-bg-image:none;--dsh-liteglass-bg-opacity:.35;--dsh-liteglass-bg-blur:0px}',
      // Background layer: fixed, behind the app frame (before #root in DOM),
      // non-interactive. Bleed by 40px so the blur edge never shows.
      '.dsh-ui-liteglass-bg{position:fixed;inset:-40px;z-index:0;pointer-events:none;background-image:var(--dsh-liteglass-bg-image);background-size:cover;background-position:center;filter:blur(var(--dsh-liteglass-bg-blur));opacity:var(--dsh-liteglass-bg-opacity)}'
    ].join('\n')

    // ---- fetch helpers (server-side persistence, multi-device) ----
    function api(url, opts) {
      return fetch(url, opts).then(function (r) { return r.json() }).catch(function () { return { ok: false, error: 'network' } })
    }
    function getConfig() { return api('/ui-liteglass/config', { method: 'GET', headers: { Accept: 'application/json' } }) }
    function saveConfig(c) {
      return api('/ui-liteglass/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) })
    }

    // ---- normalization / schema ----
    function finite(v, fallback) {
      var n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }
    function oneOf(v, list, fallback) {
      return list.indexOf(v) !== -1 ? v : fallback
    }
    function normalize(raw) {
      var src = raw && typeof raw === 'object' ? raw : {}
      var c = {}
      c.background = oneOf(src.background, BACKGROUNDS, DEFAULT_CONFIG.background)
      c.backgroundImage = typeof src.backgroundImage === 'string' ? src.backgroundImage : ''
      c.backgroundOpacity = finite(src.backgroundOpacity, DEFAULT_CONFIG.backgroundOpacity)
      c.backgroundBlur = finite(src.backgroundBlur, DEFAULT_CONFIG.backgroundBlur)
      c.panelOpacity = finite(src.panelOpacity, DEFAULT_CONFIG.panelOpacity)
      c.panelBlur = finite(src.panelBlur, DEFAULT_CONFIG.panelBlur)
      c.accentColor = /^#[0-9a-fA-F]{3,8}$/.test(src.accentColor) ? String(src.accentColor) : ''
      return c
    }
    function eq(a, b) {
      try { return JSON.stringify(a) === JSON.stringify(b) } catch (e) { return false }
    }

    // ---- color helpers ----
    function hexToRgb(hex) {
      var s = String(hex || '#000000').replace('#', '')
      if (s.length === 3) s = s.split('').map(function (ch) { return ch + ch }).join('')
      var n = parseInt(s.slice(0, 6), 16)
      return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255)
    }
    function cssUrl(u) {
      return 'url("' + String(u).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '")'
    }

    // ---- build the complete theme token override layer ----
    function buildTokens(c) {
      var t = {}
      var bgOn = c.background === 'url' || c.background === 'local'
      // Glass is on when the user lowered panel opacity OR a wallpaper is active
      // (a wallpaper needs see-through surfaces). When a wallpaper is on, force a
      // translucency ceiling so the image is actually visible behind the panels.
      var glassOn = bgOn || c.panelOpacity < 1
      if (glassOn) {
        var a = bgOn ? Math.min(c.panelOpacity, 0.85) : c.panelOpacity
        a = Math.max(0.05, Math.min(1, a))
        var lightRgb = '255,255,255' // --dsw-static-neutral-bluish-00 (light)
        var darkRgb = '21,21,23' // --dsw-static-neutral-bluish-950 (dark)
        function surface() {
          return { light: 'rgba(' + lightRgb + ',' + a + ')', dark: 'rgba(' + darkRgb + ',' + a + ')' }
        }
        t['--dsw-alias-bg-base'] = surface()
        t['--dsw-alias-bg-layer-1'] = surface()
        t['--dsw-alias-bg-layer-2'] = surface()
        t['--dsw-alias-bg-layer-3'] = surface()
        t['--dsw-specific-sidebar-fill'] = surface()
        t['--dsw-specific-input-major'] = surface()
        t['--dsw-specific-menu'] = surface()
      }
      if (c.accentColor) {
        var acc = c.accentColor
        var accRgb = hexToRgb(acc)
        t['--dsw-alias-brand-primary'] = { light: acc, dark: acc }
        t['--dsw-alias-state-business-primary'] = { light: acc, dark: acc }
        t['--dsw-specific-sidebar-nav-item-active-accent'] = { light: 'rgba(' + accRgb + ',0.18)', dark: 'rgba(' + accRgb + ',0.30)' }
        t['--dsw-alias-interactive-bg-hover-accent'] = { light: 'rgba(' + accRgb + ',0.18)', dark: 'rgba(' + accRgb + ',0.30)' }
        // The static deepseek palette feeds several aliases (info buttons,
        // business/selected states); overriding the blue tones gives accent a
        // visible reach beyond a single alias. Narrow after verifying in-browser.
        t['--dsw-static-deepseek-500'] = { light: acc, dark: acc }
        t['--dsw-static-deepseek-400'] = { light: acc, dark: acc }
      }
      return t
    }

    // ---- apply visuals (always fed a fully-normalized config) ----
    function applyBackground(c) {
      if (typeof document === 'undefined') return
      var on = c.background === 'url' || c.background === 'local'
      var root = document.documentElement
      root.style.setProperty('--dsh-liteglass-bg-image', on && c.backgroundImage ? cssUrl(c.backgroundImage) : 'none')
      root.style.setProperty('--dsh-liteglass-bg-opacity', String(finite(c.backgroundOpacity, 0.35)))
      root.style.setProperty('--dsh-liteglass-bg-blur', String(finite(c.backgroundBlur, 0)) + 'px')
      if (on) {
        if (!bgEl) {
          bgEl = document.createElement('div')
          bgEl.className = 'dsh-ui-liteglass-bg'
          bgEl.setAttribute('data-dsh-ui-liteglass', 'bg')
          var mount = document.getElementById('root')
          if (mount && mount.parentNode) mount.parentNode.insertBefore(bgEl, mount)
          else document.body.appendChild(bgEl)
        }
      } else if (bgEl) {
        bgEl.remove()
        bgEl = null
      }
    }

    function applyThemeLayer(c) {
      if (!ctxRef) return
      var theme = ctxRef.get('theme')
      if (!theme || typeof theme.overrideTokens !== 'function') return
      try { theme.overrideTokens('dsh-ui-liteglass', buildTokens(c)) } catch (e) { /* non-fatal */ }
    }

    // All visual effects (background, glass, accent). This NEVER touches
    // theme.setTheme — the plugin does not own the color mode.
    function applyVisuals(c) {
      applyBackground(c)
      applyThemeLayer(c)
    }

    // Single commit point: update the authoritative config and re-apply visuals.
    function commit(c) {
      currentConfig = c
      applyVisuals(c)
      emitStore()
    }

    // Native color mode changed (Light/Dark/System, either direction, from the
    // native settings or the OS). Purpose is LIMITED to recomputing our Accent /
    // glass token layer for the current active color scheme — we never change
    // the native theme state. (overrideTokens is already {light,dark}-paired and
    // the presenter recomputes on scheme change; this re-apply is belt-and-
    // suspenders so the layer always tracks the active scheme.)
    function onThemeChange() {
      if (currentConfig) applyThemeLayer(currentConfig)
    }

    // ---- load / persist (single load shared by activation + panel) ----
    function load() {
      return getConfig().then(function (rs) {
        var saved = (rs && rs.config) || {}
        var c = normalize(saved)
        // Repair a partial / stale config on disk so it always holds full fields.
        if (!eq(c, saved)) saveConfig(c)
        commit(c)
        return c
      })
    }
    var loadPromise = null
    function loadOnce() {
      if (!loadPromise) loadPromise = load()
      return loadPromise
    }

    // ---- settings section UI (React, createElement only) ----
    var STYLE = {
      wrap: { padding: '6px 0', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 14 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      label: { fontSize: 13, lineHeight: '20px' },
      hint: { fontSize: 11, opacity: 0.55, maxWidth: 420 },
      seg: { display: 'inline-flex', border: '1px solid rgba(128,128,128,.35)', borderRadius: 6, overflow: 'hidden' },
      segBtn: { border: 0, background: 'transparent', padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: 'inherit' },
      segOn: { border: 0, background: 'rgba(90,140,255,.22)', padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: 'inherit', fontWeight: 600 },
      input: { border: '1px solid rgba(128,128,128,.35)', background: 'transparent', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: 'inherit', minWidth: 220 },
      range: { width: 160 },
      note: { fontSize: 11, opacity: 0.55 }
    }

    function Segmented(props) {
      return h('div', { style: STYLE.seg }, props.options.map(function (o) {
        return h('button', {
          key: o.value,
          style: o.value === props.value ? STYLE.segOn : STYLE.segBtn,
          onClick: function () { props.onChange(o.value) }
        }, o.label)
      }))
    }

    function Slider(props) {
      var value = Number.isFinite(props.value) ? props.value : props.fallback
      return h('div', { style: STYLE.row }, [
        h('span', { style: STYLE.label }, props.label),
        h('input', {
          type: 'range',
          min: String(props.min),
          max: String(props.max),
          step: String(props.step || 0.01),
          value: String(value),
          style: STYLE.range,
          onChange: function (ev) { props.onChange(Number(ev.target.value)) }
        })
      ])
    }

    // Subscribe the React render to the single authoritative `currentConfig`.
    // On mount this initializes from `currentConfig` (live state), and on every
    // commit it re-renders. There is NO independent React config; DEFAULT_CONFIG
    // is only the normalization fallback when no config exists yet.
    function useAppearanceConfig() {
      var state = useState(currentConfig)
      var set = state[1]
      useEffect(function () {
        return subscribeStore(function () { set(currentConfig) })
      }, [])
      return state[0]
    }

    function SettingsPanel() {
      var config = useAppearanceConfig()

      // Every edit reads the authoritative `currentConfig` (module-level,
      // latest) — never a React closure or a stale snapshot — then commits the
      // visuals and persists. No edit ever touches theme.setTheme.
      function patch(p) {
        var base = currentConfig || DEFAULT_CONFIG
        var next = normalize(Object.assign({}, base, p))
        commit(next)
        saveConfig(next)
      }

      if (!config) return h('div', { style: STYLE.note }, 'Loading appearance settings…')

      var bgIsUrl = config.background === 'url'
      var bgIsLocal = config.background === 'local'

      return h('div', { style: STYLE.wrap }, [
        h('div', { style: STYLE.row }, [
          h('span', { style: STYLE.label }, '背景'),
          h(Segmented, {
            value: config.background,
            onChange: function (v) { patch({ background: v }) },
            options: [
              { value: 'off', label: '关闭' },
              { value: 'url', label: 'URL' },
              { value: 'local', label: '本地图片' }
            ]
          })
        ]),
        bgIsUrl ? h('div', { style: STYLE.row }, [
          h('span', { style: STYLE.label }, '图片 URL'),
          h('input', {
            style: STYLE.input,
            type: 'text',
            placeholder: 'https://example.com/wallpaper.jpg',
            value: config.backgroundImage || '',
            onChange: function (ev) { patch({ backgroundImage: ev.target.value }) }
          })
        ]) : null,
        bgIsLocal ? h('div', { style: STYLE.row }, [
          h('span', { style: STYLE.label }, '上传背景图'),
          h('input', { type: 'file', accept: 'image/*', onChange: onUpload })
        ]) : null,
        config.background !== 'off'
          ? h('div', { style: STYLE.note }, config.backgroundImage ? '当前背景：' + config.backgroundImage : '请设置或上传背景图片')
          : null,
        h(Slider, { label: '背景不透明度 ' + Math.round(config.backgroundOpacity * 100) + '%', value: config.backgroundOpacity, fallback: 0.35, min: 0, max: 1, onChange: function (v) { patch({ backgroundOpacity: v }) } }),
        h(Slider, { label: '背景模糊 ' + config.backgroundBlur + 'px', value: config.backgroundBlur, fallback: 0, min: 0, max: 40, step: 1, onChange: function (v) { patch({ backgroundBlur: v }) } }),
        h(Slider, { label: '面板不透明度 ' + Math.round(config.panelOpacity * 100) + '%', value: config.panelOpacity, fallback: 1, min: 0.05, max: 1, onChange: function (v) { patch({ panelOpacity: v }) } }),
        h('div', { style: STYLE.row }, [
          h('div', {}, [
            h('div', { style: STYLE.label }, '面板模糊 (Panel Blur)'),
            h('div', { style: STYLE.hint }, '已临时禁用 backdrop-filter（避免破坏布局）；设置暂存待后续启用')
          ]),
          h('span', { style: STYLE.note }, config.panelBlur + 'px')
        ]),
        h('div', { style: STYLE.row }, [
          h('span', { style: STYLE.label }, '重点色 (Accent)'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            h('input', {
              type: 'color',
              value: config.accentColor || '#4176e6',
              onChange: function (ev) { patch({ accentColor: ev.target.value }) }
            }),
            config.accentColor
              ? h('button', { style: STYLE.segBtn, onClick: function () { patch({ accentColor: '' }) } }, '还原原生')
              : null
          ])
        ])
      ])

      function onUpload(ev) {
        var file = ev.target.files && ev.target.files[0]
        if (!file) return
        api('/ui-liteglass/background', { method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file })
          .then(function (r) {
            if (r && r.ok && r.url) patch({ background: 'local', backgroundImage: r.url })
          })
      }
    }

    // ---- plugin ----
    function apply(ctx) {
      ctxRef = ctx

      try {
        ctx.effect(function () {
          var tag = document.createElement('style')
          tag.setAttribute('data-plugin', 'dsh-ui-liteglass')
          tag.setAttribute('data-plugin-css', 'dsh-ui-liteglass/base')
          tag.textContent = CSS
          document.head.appendChild(tag)
          return function () { tag.remove() }
        }, 'dsh-ui-liteglass: base stylesheet')
      } catch (e) { /* non-fatal */ }

      // Watch native color-mode changes ONLY to recompute our Accent/glass token
      // layer for the active scheme. Never calls setTheme.
      try {
        ctx.effect(function () {
          return ctx.on('theme/change', onThemeChange)
        }, 'dsh-ui-liteglass: theme/change listener')
      } catch (e) { /* non-fatal */ }

      loadOnce()

      var slots = ctx.get('slots')
      if (slots) {
        try {
          slots.inject('settings.section', function () {
            return slots.register(
              { name: 'settings.section', id: 'dsh-ui-liteglass', order: 50, label: '外观 (Appearance)' },
              function () { return h(SettingsPanel, {}) }
            )
          })
        } catch (e) { /* non-fatal */ }
      }
    }

    exports.inject = ['slots', 'theme']
    exports.apply = apply
    return module.exports
  }
})
