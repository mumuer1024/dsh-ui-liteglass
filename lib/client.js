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
    var themeDispose = null // disposer of the current theme override layer
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
      backgroundOpacity: 0.4,
      backgroundBlur: 0,
      panelOpacity: 1, // 1 = fully opaque = native (plugin off by default)
      panelBlur: 0,
      accentColor: '',
      // Opt-in: paint primary buttons with the accent color. Off by default so
      // the DSH 0.2.x monochrome primary button keeps its native fill.
      accentButtons: false
    }
    var BACKGROUNDS = ['off', 'url', 'local']

    // Control grids. Sliders used to emit 1% steps, which meant a network write
    // plus a full token-layer rebuild per pixel of drag; these parameters now
    // change in segments instead.
    var OPACITY_STEP = 0.1
    var BLUR_STEP = 5
    var BLUR_MAX = 30

    // Upload policy, mirrored from the host: the panel checks the limit before
    // sending, so an oversized file never leaves the browser.
    var MAX_UPLOAD_BYTES = 8 * 1024 * 1024
    var ACCEPTED_UPLOADS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

    // Accent swatches. DSH 0.2.x has NO accent setting of its own (the ui-theme
    // document only carries preference/fontFamily/fontSize), so this control is
    // entirely plugin-owned and the palette is ours to choose.
    // PLACEHOLDER palette — swap the nine values when the final set is supplied.
    var ACCENT_PRESETS = [
      { name: '靛蓝', value: '#4176e6' },
      { name: '青碧', value: '#12a594' },
      { name: '竹青', value: '#3f9142' },
      { name: '琥珀', value: '#e4c249' },
      { name: '橙霞', value: '#e8703a' },
      { name: '绯红', value: '#d64545' },
      { name: '藕荷', value: '#a45dc4' },
      { name: '黛紫', value: '#6b5bd2' },
      { name: '石墨', value: '#6f7683' }
    ]

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
      '.dsh-ui-liteglass-bg{position:fixed;inset:-40px;z-index:0;pointer-events:none;background-image:var(--dsh-liteglass-bg-image);background-size:cover;background-position:center;filter:blur(var(--dsh-liteglass-bg-blur));opacity:var(--dsh-liteglass-bg-opacity)}',
    ].join('\n')

    // ---- fetch helpers (server-side persistence, multi-device) ----
    function api(url, opts) {
      return fetch(url, opts).then(function (r) {
        return r.json().then(function (body) {
          return Object.assign({ status: r.status }, body)
        }, function () {
          return { status: r.status, ok: false, error: 'bad response' }
        })
      }).catch(function () { return { ok: false, error: 'network' } })
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
    // Quantize a number onto a fixed grid. The panel edits parameters in
    // segments (10% / 5px), so the stored value must be representable by the
    // control that edits it — otherwise the UI shows a value it cannot set.
    function snap(v, step, min, max) {
      var n = Number(v)
      if (!Number.isFinite(n)) return v
      var q = Math.round(n / step) * step
      q = Math.max(min, Math.min(max, q))
      return Math.round(q * 1000) / 1000
    }
    function normalize(raw) {
      var src = raw && typeof raw === 'object' ? raw : {}
      var c = {}
      c.background = oneOf(src.background, BACKGROUNDS, DEFAULT_CONFIG.background)
      c.backgroundImage = typeof src.backgroundImage === 'string' ? src.backgroundImage : ''
      c.backgroundOpacity = snap(finite(src.backgroundOpacity, DEFAULT_CONFIG.backgroundOpacity), OPACITY_STEP, 0, 1)
      c.backgroundBlur = snap(finite(src.backgroundBlur, DEFAULT_CONFIG.backgroundBlur), BLUR_STEP, 0, BLUR_MAX)
      c.panelOpacity = snap(finite(src.panelOpacity, DEFAULT_CONFIG.panelOpacity), OPACITY_STEP, OPACITY_STEP, 1)
      c.panelBlur = snap(finite(src.panelBlur, DEFAULT_CONFIG.panelBlur), BLUR_STEP, 0, BLUR_MAX)
      c.accentColor = /^#[0-9a-fA-F]{3,8}$/.test(src.accentColor) ? String(src.accentColor) : ''
      c.accentButtons = src.accentButtons === true
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
    function rgba(rgb, a) {
      return 'rgba(' + rgb + ',' + a + ')'
    }
    function clampAlpha(a) {
      return Math.max(0.05, Math.min(0.98, Math.round(a * 100) / 100))
    }
    // Relative luminance (sRGB) of a hex color, 0..1. Used to pick a legible
    // foreground for an accent fill instead of assuming white always works.
    function hexLuminance(hex) {
      var s = String(hex || '').replace('#', '')
      if (s.length === 3) s = s.split('').map(function (ch) { return ch + ch }).join('')
      if (s.length < 6) return 0
      function channel(i) {
        var v = parseInt(s.slice(i, i + 2), 16) / 255
        if (!Number.isFinite(v)) return 0
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
    }
    function onAccentColor(hex) {
      return hexLuminance(hex) > 0.45 ? '#0f0f0f' : '#ffffff'
    }

    // ---- build the complete theme token override layer ----
    // Surface ladder: every token below the base gets progressively MORE
    // opaque, so nesting still reads as depth above a wallpaper. DSH 0.2.x
    // encodes depth with three distinct raised tones (light: all white with
    // borders; dark: bluish-875/850/800), so flattening them all to one value
    // would erase the hierarchy the native UI relies on.
    var SURFACE_LADDER = [
      ['--dsw-alias-bg-base', 0],
      ['--dsw-specific-sidebar-fill', 0.02],
      ['--dsw-alias-bg-layer-1', 0.03],
      ['--dsw-alias-bg-module-platform', 0.04],
      ['--dsw-specific-selector', 0.05],
      ['--dsw-alias-bg-layer-2', 0.06],
      ['--dsw-specific-input-major', 0.06],
      ['--dsw-alias-bg-layer-3', 0.09],
      ['--dsw-alias-bg-overlay', 0.10],
      ['--dsw-specific-menu', 0.12]
    ]
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
        for (var i = 0; i < SURFACE_LADDER.length; i += 1) {
          var token = SURFACE_LADDER[i][0]
          var alpha = clampAlpha(a + SURFACE_LADDER[i][1])
          t[token] = { light: rgba(lightRgb, alpha), dark: rgba(darkRgb, alpha) }
        }
      }
      // "Panel blur" is a floating-layer effect, not a surface tint: the platform
      // frosts nothing behind a modal by default (`--dsw-mask-blur: none`), so
      // setting this token is what makes the page behind Settings (and any other
      // masked dialog) fall out of focus. It reaches every mask that dims the
      // page, including the ones drawn by other plugins.
      var maskBlur = finite(c.panelBlur, 0)
      var maskValue = maskBlur > 0 ? 'blur(' + maskBlur + 'px)' : 'none'
      t['--dsw-mask-blur'] = { light: maskValue, dark: maskValue }
      if (c.accentColor) {
        var acc = c.accentColor
        var accRgb = hexToRgb(acc)
        t['--dsw-alias-state-business-primary'] = { light: acc, dark: acc }
        t['--dsw-specific-sidebar-nav-item-active-accent'] = { light: 'rgba(' + accRgb + ',0.18)', dark: 'rgba(' + accRgb + ',0.30)' }
        t['--dsw-alias-interactive-bg-hover-accent'] = { light: 'rgba(' + accRgb + ',0.18)', dark: 'rgba(' + accRgb + ',0.30)' }
        // --dsw-static-deepseek-400/500 feed --dsw-alias-link,
        // --dsw-alias-button-info-fill and the business/selected aliases, which
        // gives the accent reach beyond a single token.
        t['--dsw-static-deepseek-500'] = { light: acc, dark: acc }
        t['--dsw-static-deepseek-400'] = { light: acc, dark: acc }
        // DSH 0.2.x paints the primary button with --dsw-alias-brand-primary,
        // which is monochrome (near-black in light, near-white in dark). It is
        // only recolored on explicit request, and then paired with a foreground
        // chosen for contrast against the accent itself.
        if (c.accentButtons) {
          t['--dsw-alias-brand-primary'] = { light: acc, dark: acc }
          var fg = onAccentColor(acc)
          t['--dsw-alias-label-primary-foreground'] = { light: fg, dark: fg }
        }
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
      try {
        // Re-overriding with the same source replaces the layer, which makes an
        // older disposer a documented no-op; keep the current one so unload
        // retires exactly the layer that is still standing.
        themeDispose = theme.overrideTokens('dsh-ui-liteglass', buildTokens(c))
      } catch (e) { /* non-fatal */ }
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
    // Set when the server could not be read. A failed read is NOT an empty
    // config: committing defaults here and writing them back is exactly what
    // turned a transient 401 into a visible reset.
    var loadError = null

    function load() {
      return getConfig().then(function (rs) {
        var readable = rs && rs.ok === true && rs.config !== null && typeof rs.config === 'object'
        if (!readable) {
          loadError = rs && rs.status ? 'HTTP ' + rs.status : '网络不可达'
          emitStore()
          return null
        }
        loadError = null
        var saved = rs.config
        var c = normalize(saved)
        // Repair a partial / stale document — but only now that the read proved
        // the file is reachable, never on a failed read.
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

    // ---- settings panel UI (React, createElement only) ----
    var STYLE = {
      wrap: { padding: '16px 0', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 14, borderBottom: '.5px solid var(--dsw-alias-border-l2)' },
      title: { fontSize: 14, lineHeight: '20px', fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      label: { fontSize: 13, lineHeight: '20px' },
      hint: { fontSize: 11, opacity: 0.55, maxWidth: 420 },
      seg: { display: 'inline-flex', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 6, overflow: 'hidden' },
      segBtn: { border: 0, background: 'transparent', padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: 'inherit' },
      segOn: { border: 0, background: 'var(--dsw-alias-bg-module-platform)', padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: 'inherit', fontWeight: 600 },
      input: { border: '.5px solid var(--dsw-alias-border-l3)', background: 'transparent', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: 'inherit', minWidth: 220 },
      select: { border: '.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-module-platform)', borderRadius: 6, padding: '2px 6px', fontSize: 12, lineHeight: '20px', color: 'inherit', minWidth: 96 },
      hexInput: { border: '.5px solid var(--dsw-alias-border-l3)', background: 'transparent', borderRadius: 6, padding: '2px 8px', fontSize: 12, lineHeight: '20px', color: 'inherit', width: 108, fontFamily: 'ui-monospace, monospace' },
      swatches: { display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'flex-end', maxWidth: 460 },
      swatch: { width: 22, height: 22, padding: 0, borderRadius: 999, border: '.5px solid var(--dsw-alias-border-l2)', cursor: 'pointer', color: 'inherit' },
      swatchOn: { width: 22, height: 22, padding: 0, borderRadius: 999, border: '.5px solid var(--dsw-alias-border-l2)', cursor: 'pointer', color: 'inherit', outline: '2px solid var(--dsw-alias-state-business-primary)', outlineOffset: 1 },
      swatchNative: { border: '.5px solid var(--dsw-alias-border-l3)', background: 'transparent', borderRadius: 999, padding: '2px 10px', fontSize: 11, lineHeight: '18px', cursor: 'pointer', color: 'inherit' },
      swatchNativeOn: { border: '.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform)', borderRadius: 999, padding: '2px 10px', fontSize: 11, lineHeight: '18px', cursor: 'pointer', color: 'inherit', fontWeight: 600 },
      error: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-error)' },
      success: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary)' },
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

    // One dropdown per parameter: a single commit per choice, and no drag that
    // can write on every pixel.
    function Select(props) {
      return h('div', { style: STYLE.row }, [
        h('span', { style: STYLE.label }, props.label),
        h('select', {
          style: STYLE.select,
          'aria-label': props.label,
          value: String(props.value),
          onChange: function (ev) { props.onChange(Number(ev.target.value)) }
        }, props.options.map(function (o) {
          return h('option', { key: String(o.value), value: String(o.value) }, o.label)
        }))
      ])
    }

    function percentOptions(min, max) {
      var out = []
      for (var v = min; v <= max + 1e-9; v += OPACITY_STEP) {
        var q = Math.round(v * 10) / 10
        out.push({ value: q, label: Math.round(q * 100) + '%' })
      }
      return out
    }

    function pixelOptions(min, max) {
      var out = []
      for (var v = min; v <= max + 1e-9; v += BLUR_STEP) out.push({ value: v, label: v + 'px' })
      return out
    }

    function formatBytes(n) {
      var mib = Number(n) / (1024 * 1024)
      if (Number.isFinite(mib) && mib >= 0.1) return mib.toFixed(1) + ' MiB'
      return Math.max(1, Math.round(Number(n) / 1024)) + ' KiB'
    }

    function isPresetColor(value) {
      var wanted = String(value || '').toLowerCase()
      return ACCENT_PRESETS.some(function (p) { return p.value.toLowerCase() === wanted })
    }

    // Turn a rejected upload into copy a user can act on.
    function uploadError(r) {
      var status = r && r.status
      if (status === 401) return '会话已失效，请重新登录后再上传'
      if (status === 413) return '服务器拒绝：图片超过 8 MiB 上限，未保存'
      if (status === 415) return '服务器拒绝：格式不受支持，或文件内容与所选格式不符'
      if (status === 403) return '服务器拒绝：跨站请求不被允许'
      if (r && r.error === 'network') return '网络错误，请检查连接后重试'
      return '上传失败' + (r && r.error ? '：' + r.error : '')
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
      // Transient upload feedback (busy / error / success). Not plugin config:
      // it never persists and is not part of the authoritative store.
      var upload = useState({ busy: false, error: '', ok: '' })
      var uploadState = upload[0]
      var setUpload = upload[1]
      // null = mirror the stored accent; a string means the user is typing.
      var hexDraftState = useState(null)
      var hexDraft = hexDraftState[0]
      var setHexDraft = hexDraftState[1]
      var hexErrState = useState('')
      var hexError = hexErrState[0]
      var setHexError = hexErrState[1]
      // Last write failure, shown instead of being swallowed.
      var saveErrState = useState('')
      var saveError = saveErrState[0]
      var setSaveError = saveErrState[1]

      // Accept only a hex code. No picker, and nothing is patched until the text
      // is a complete color, so half-typed values never reach the config.
      function commitHex() {
        var raw = String(hexDraft === null ? (config && config.accentColor) || '' : hexDraft).trim()
        if (raw === '') {
          setHexDraft(null)
          setHexError('')
          patch({ accentColor: '' })
          return
        }
        var normalized = raw.charAt(0) === '#' ? raw : '#' + raw
        // Keep an invalid draft in place so it can be corrected instead of
        // silently reverting to the previous color.
        if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(normalized)) {
          setHexError('仅支持色号格式，如 #4176e6 或 #abc')
          return
        }
        setHexError('')
        setHexDraft(null)
        patch({ accentColor: normalized.toLowerCase() })
      }

      // Every edit reads the authoritative `currentConfig` (module-level,
      // latest) — never a React closure or a stale snapshot — then commits the
      // visuals and persists. No edit ever touches theme.setTheme.
      function patch(p) {
        var base = currentConfig || DEFAULT_CONFIG
        var next = normalize(Object.assign({}, base, p))
        // Re-clicking the active segment would otherwise rebuild the token
        // layer and POST the same document again.
        if (eq(next, currentConfig)) return
        commit(next)
        saveConfig(next).then(function (rs) {
          if (rs && rs.ok) { setSaveError(''); return }
          // A discarded write must be visible; silence here is what made a
          // rejected request look like a saved setting.
          setSaveError('未能保存到服务端（' + (rs && rs.status ? 'HTTP ' + rs.status : '网络不可达') +
            '），刷新后这里会回到上次成功保存的值')
        })
      }

      if (!config) {
        return h('div', { style: STYLE.wrap }, [
          h('div', { style: STYLE.title }, '壁纸与玻璃 (LiteGlass)'),
          h('div', { style: loadError ? STYLE.error : STYLE.note, role: loadError ? 'alert' : 'status' },
            loadError
              ? '无法读取已保存的外观配置（' + loadError + '）。为避免覆盖服务端配置，这次没有应用任何设置；刷新页面重试，或重新登录后再进。'
              : '正在读取外观设置…')
        ])
      }

      var hexText = hexDraft === null ? config.accentColor || '' : hexDraft
      var bgIsUrl = config.background === 'url'
      var bgIsLocal = config.background === 'local'

      return h('div', { style: STYLE.wrap }, [
        h('div', { style: STYLE.title }, '壁纸与玻璃 (LiteGlass)'),
        saveError ? h('div', { style: STYLE.error, role: 'alert' }, saveError) : null,
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
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' } }, [
            h('input', {
              type: 'file',
              accept: ACCEPTED_UPLOADS.join(','),
              disabled: !!uploadState.busy,
              onChange: onUpload
            }),
            h('span', { style: STYLE.hint }, '单张上限 8 MiB（超限不会上传）；支持 PNG / JPEG / WebP / GIF')
          ])
        ]) : null,
        bgIsLocal && uploadState.busy ? h('div', { style: STYLE.note, role: 'status' }, '上传中…') : null,
        bgIsLocal && uploadState.error ? h('div', { style: STYLE.error, role: 'alert' }, uploadState.error) : null,
        bgIsLocal && uploadState.ok ? h('div', { style: STYLE.success, role: 'status' }, uploadState.ok) : null,
        config.background !== 'off'
          ? h('div', { style: STYLE.note }, config.backgroundImage ? '当前背景：' + config.backgroundImage : '请设置或上传背景图片')
          : null,
        h(Select, { label: '背景不透明度', value: config.backgroundOpacity, options: percentOptions(0, 1), onChange: function (v) { patch({ backgroundOpacity: v }) } }),
        h(Select, { label: '背景模糊', value: config.backgroundBlur, options: pixelOptions(0, BLUR_MAX), onChange: function (v) { patch({ backgroundBlur: v }) } }),
        h(Select, { label: '面板不透明度', value: config.panelOpacity, options: percentOptions(OPACITY_STEP, 1), onChange: function (v) { patch({ panelOpacity: v }) } }),
        h(Select, { label: '浮层模糊', value: config.panelBlur, options: pixelOptions(0, BLUR_MAX), onChange: function (v) { patch({ panelBlur: v }) } }),
        h('div', { style: STYLE.note }, '对设置弹窗、对话框等“蒙层”背后的内容做磨砂（DSH 默认不磨砂）。弹出菜单/工具面板本身已由系统自带的 40px 磨砂处理；侧栏与输入框背后只有壁纸，那里看不出差别——那种情况请用「背景模糊」'),
        h('div', { style: STYLE.row }, [
          h('span', { style: STYLE.label }, '重点色'),
          h('div', { style: STYLE.swatches, role: 'group', 'aria-label': '重点色预设' },
            [h('button', {
              key: 'native',
              title: '原生：不注入重点色',
              style: config.accentColor === '' ? STYLE.swatchNativeOn : STYLE.swatchNative,
              'aria-pressed': config.accentColor === '' ? 'true' : 'false',
              onClick: function () { setHexDraft(null); setHexError(''); patch({ accentColor: '' }) }
            }, '原生')].concat(ACCENT_PRESETS.map(function (preset) {
              var on = String(config.accentColor || '').toLowerCase() === preset.value.toLowerCase()
              return h('button', {
                key: preset.value,
                title: preset.name + ' ' + preset.value,
                'aria-label': preset.name,
                'aria-pressed': on ? 'true' : 'false',
                'data-accent': preset.value,
                style: Object.assign({ background: preset.value }, on ? STYLE.swatchOn : STYLE.swatch),
                onClick: function () { setHexDraft(null); setHexError(''); patch({ accentColor: preset.value }) }
              })
            }))
          )
        ]),
        h('div', { style: STYLE.row }, [
          h('span', { style: STYLE.label }, '自定义色号'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            h('input', {
              type: 'text',
              style: STYLE.hexInput,
              value: hexText,
              placeholder: '#4176e6',
              maxLength: 9,
              spellCheck: false,
              'aria-label': '自定义重点色号',
              onChange: function (ev) { setHexDraft(ev.target.value); setHexError('') },
              onBlur: commitHex,
              onKeyDown: function (ev) { if (ev.key === 'Enter') commitHex() }
            }),
            h('span', { style: STYLE.hint }, '只收色号（#RGB / #RRGGBB），不提供取色器；回车或失焦生效')
          ])
        ]),
        hexError
          ? h('div', { style: STYLE.error, role: 'alert' }, hexError)
          : null,
        config.accentColor && !isPresetColor(config.accentColor)
          ? h('div', { style: STYLE.note }, '当前为自定义色 ' + config.accentColor + '（不在预设内），点「原生」可清除')
          : null,
        config.accentColor
          ? h('div', { style: STYLE.row }, [
            h('label', { style: STYLE.label }, [
              h('input', {
                type: 'checkbox',
                checked: !!config.accentButtons,
                onChange: function (ev) { patch({ accentButtons: ev.target.checked }) }
              }),
              ' 彩色主按钮'
            ]),
            h('span', { style: STYLE.hint }, '默认只染强调态；开启后主按钮也使用重点色')
          ])
          : null
      ])

      function onUpload(ev) {
        var input = ev.target
        var file = input.files && input.files[0]
        if (!file) return
        var type = String(file.type || '').toLowerCase()
        if (ACCEPTED_UPLOADS.indexOf(type) === -1) {
          setUpload({ busy: false, ok: '', error: '不支持该格式，请选择 PNG / JPEG / WebP / GIF' })
          input.value = ''
          return
        }
        // Reject oversized files here: the point is to say so before spending
        // the upload, not after the server answers 413.
        if (file.size > MAX_UPLOAD_BYTES) {
          setUpload({ busy: false, ok: '', error: '图片 ' + formatBytes(file.size) + '，超过 8 MiB 上限，未上传；请压缩后再试' })
          input.value = ''
          return
        }
        setUpload({ busy: true, ok: '', error: '' })
        api('/ui-liteglass/background', { method: 'POST', headers: { 'Content-Type': type }, body: file })
          .then(function (r) {
            if (r && r.ok && r.url) {
              patch({ background: 'local', backgroundImage: r.url })
              setUpload({ busy: false, ok: '已上传并应用（' + formatBytes(file.size) + '）', error: '' })
            } else {
              setUpload({ busy: false, ok: '', error: uploadError(r) })
            }
            input.value = ''
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

      // Unload restores the native look: retire the token layer and remove the
      // wallpaper node. A bundle client module is NOT wrapped by the dynamic
      // package facade, so nothing else removes either of them.
      try {
        ctx.effect(function () {
          return function () {
            if (typeof themeDispose === 'function') {
              try { themeDispose() } catch (e) { /* non-fatal */ }
            }
            themeDispose = null
            if (bgEl && bgEl.parentNode) bgEl.parentNode.removeChild(bgEl)
            bgEl = null
          }
        }, 'dsh-ui-liteglass: visuals teardown')
      } catch (e) { /* non-fatal */ }

      // One appearance surface: the row seat inside the General settings page,
      // next to the native Appearance row (DSH 0.2.x moved that row out of its
      // own page, so a second page named "Appearance" would split the same
      // preference across two entries).
      var slots = ctx.get('slots')
      if (slots) {
        try {
          slots.inject('settings.general.item', function () {
            return slots.register(
              { name: 'settings.general.item', id: 'dsh-ui-liteglass', order: 20 },
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
