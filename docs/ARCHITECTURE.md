# dsh-ui-liteglass — Architecture

Technical notes for maintainers and contributors. This is **not** the user-facing
README. It describes how the plugin is built against DeepSeek Harness and where
its behavior is enforced, based on the current final source.

Scope: **Wallpaper + Glass + Accent — only.** The plugin does **not** provide,
persist, or control the Light / Dark / System color mode. Color mode is owned
entirely by DSH native settings; the plugin never calls `theme.setTheme`.

---

## 1. Dual-half structure

`dsh-ui-liteglass` is one npm package shipping two halves:

| Half | File | Runs on | Role |
|---|---|---|---|
| Host | `lib/index.js` | the DSH server process | HTTP routes, config + background persistence |
| Web client | `lib/client.js` | the browser | CSS injection, `theme.overrideTokens`, Settings UI |

The client half is authored in the client-modules module-table format
(`window.__ModuleLoader__.load({ id, factory })`) and uses `require('react')`
from the shell's module table — **no build step, no bundled React**.

## 2. DSH profile bundle / client plugin integration

The package is installed into a DSH profile as a **bundle**. Relevant metadata:

- `dsh.bundle.patch` → `cordis.patch.yml` mounts the **host** half as a loader
  entry (`id: ui-liteglass`, `inject: [webServer, settings]`).
- `dsh.client` declares `{ platform: "web", inject: ["@deepseek-ai/dsh-client-ui-theme"] }`.
  The `inject` here is the client-side dependency ordering — the theme client
  bundle must be active before this plugin's client.
- `exports["."]` → `lib/index.js` (host apply), `exports["./client"]` →
  `lib/client.js` (served by client-modules at `/plugins/dsh-ui-liteglass/client.js`).

The client is adopted by the Cordis client runner, which wraps `apply(ctx)` with a
**guarded context**: service access is gated by the returned `inject` array
(`exports.inject = ['slots', 'theme']`). Within that guard:

- `theme.overrideTokens(source, tokens)` **forces `source` to this package id**
  and auto-hangs the layer's disposer on the fiber. The plugin can never
  impersonate or evict another source's override layer, and its own layer is
  removed on unload.
- `theme.setTheme` is intentionally never used.

## 3. Host routes

Registered on the DSH `webServer` service (`webServer.register`):

| Route | Kind | Purpose |
|---|---|---|
| `GET/POST /ui-liteglass/config` | exact | read / write the plugin config JSON |
| `GET /ui-liteglass/state` | exact | expose the native theme preference (read-only; the plugin never changes it) |
| `POST /ui-liteglass/background` | exact | accept an uploaded wallpaper image (raw body, content-type whitelisted) |
| `GET /ui-liteglass/backgrounds/*` | prefix | serve stored wallpaper files |

Route notes:

- `webServer` matches prefix routes via `pathname.startsWith(prefix + "/")`, so
  the `backgrounds` prefix is registered **without** a trailing slash (a trailing
  slash would double into `"//"` and never match).
- Stored background filenames are `sha1(content)[0:16] + ext`, validated against
  `^[0-9a-f]{16}\.(png|jpg|webp|gif)$` **before** any path join. Anything else
  (path traversal, bogus names) → 400; a well-formed but missing file → 404.
- Upload MIME types are whitelisted (`png/jpeg/webp/gif`); anything else is
  rejected (e.g. `svg` is excluded deliberately).

## 4. Config & background persistence

Everything persists **server-side**, under `$DSH_HOME/ui-liteglass/`:

```
$DSH_HOME/ui-liteglass/
  config.json          # small normalized config (all plugin settings)
  backgrounds/<id>.<ext>   # uploaded wallpaper files
```

- The config JSON is a small document; a wallpaper is referenced by a
  **server-relative URL** (`/ui-liteglass/backgrounds/<id>.<ext>`), never by a
  client blob. Because storage is on the host, any device that reaches the DSH
  host sees the same wallpaper and config (multi-device).
- The host `sanitizeConfig` normalizes/whitelists every field on write, so the
  on-disk config is always complete and finite (no `NaN`/`undefined`).
- Config writes and reads go through the HTTP routes. This avoids the native
  settings transport for this plugin's data (see §8).

## 5. Client authoritative state model

`lib/client.js` keeps a **single authoritative source of truth**:
module-level `currentConfig`.

- `normalize(raw)` merges any server config (which may be partial / null / stale)
  over `DEFAULT_CONFIG`, guaranteeing every field is present and every number is
  finite. Server config is never trusted to be complete.
- A tiny module-level pub/sub (`emitStore` / `subscribeStore`) drives React
  re-renders. React component state is only a **subscription mirror** — there is
  no independent React config.
- `useAppearanceConfig()` initializes from `currentConfig` and subscribes, so
  Settings **unmount → remount** always hydrates from the live config, never from
  a cached snapshot or `DEFAULT_CONFIG`. `DEFAULT_CONFIG` is used only as the
  normalization fallback when no config exists yet.
- All edits go through `patch()`, which reads `currentConfig` (not a React
  closure), so rapid / concurrent field updates never drop one another.
- On first load the plugin fetches the persisted config, repairs a partial config
  on disk, and applies visuals.

## 6. `theme.overrideTokens` (Accent + Glass)

`applyThemeLayer(c)` calls `theme.overrideTokens('dsh-ui-liteglass', tokens)`.
The layer is a set of `{ light, dark }` pairs; the native theme presenter picks
the value matching the **active color scheme**, so Accent and glass surfaces
adapt automatically when DSH switches Light/Dark.

- **Glass**: when a wallpaper is active or `panelOpacity < 1`, a set of surface
  tokens (`--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1/2/3`,
  `--dsw-specific-sidebar-fill`, `--dsw-specific-input-major`,
  `--dsw-specific-menu`) is overridden to translucent `rgba(...)`.
  A wallpaper forces a translucency ceiling (≤ 0.85) so the image shows through.
- **Accent**: when `accentColor` is set, a small set of alias tokens
  (`--dsw-alias-brand-primary`, `--dsw-alias-state-business-primary`,
  `--dsw-specific-sidebar-nav-item-active-accent`,
  `--dsw-alias-interactive-bg-hover-accent`) and two static deepseek palette
  tones (`--dsw-static-deepseek-500/400`) are overridden. Reusing a `{light,dark}`
  override via the native token system deliberately avoids building a second theme
  system.

## 7. `theme/change` — read-only listener

The client registers `ctx.on('theme/change', onThemeChange)`. Its purpose is
**limited** to recomputing the Accent/glass token layer for the active color
scheme (`applyThemeLayer(currentConfig)`). It never calls `setTheme` and never
changes the native theme state.

## 8. Why not `settingsScope` / native settings for persistence

DSH's `settingsScope` persistence is decided by
`connection.isLoopback ? "host" : "memory"`. For a browser accessing the host
remotely (non-loopback), settings writes are process-local and **not durable**.
Because this plugin must persist config and wallpaper for **any** client device,
it avoids `settingsScope` entirely and persists via its own HTTP routes + the
server filesystem. The host `settings` service is read only to expose the native
preference (read-only; the plugin never changes it).

## 9. CSS / DOM / id prefixes

All plugin-owned identifiers are namespaced to avoid collisions:

| Kind | Prefix |
|---|---|
| package / plugin id | `dsh-ui-liteglass` |
| CSS custom properties | `--dsh-liteglass-*` |
| DOM class / data attribute | `dsh-ui-liteglass-*` / `[data-dsh-ui-liteglass=...]` |
| injected `<style>` tags | `data-plugin="dsh-ui-liteglass"` |
| settings.section id | `dsh-ui-liteglass` |
| theme override source id | forced to this package id by the runner |

Canonical identity record (package / plugin id / rowId / display name):
[`docs/IDENTITY.md`](IDENTITY.md).

## 10. Background layer & panel blur

- Wallpaper is a fixed, non-interactive layer `.dsh-ui-liteglass-bg`
  (`position:fixed; z-index:0; pointer-events:none`), inserted before `#root`, with
  `filter: blur(...)` and `opacity` driven by CSS variables.
- **Panel `backdrop-filter` blur is disabled.** Applying `backdrop-filter` to the
  three column containers (`.pI_x6G_sidebarCol/centerCol/detailsCol`) created a
  containing block / stacking context that broke `position:fixed` overlays (the
  Settings page shifted into the sidebar). The `panelBlur` value is still stored
  but has **no visual effect** in the current build. Glass is achieved with
  translucent token surfaces + a blurred background layer only. Re-enabling panel
  blur requires finding an inner container that does not alter fixed-position
  layout semantics — not the three columns.

## 11. Graceful degradation / compatibility

- Build-coupled `.pI_x6G_*` classes are not used as hard dependencies in the
  current client (the panel blur rule that referenced them is disabled); a missing
  selector degrades gracefully rather than breaking the UI.
- Server-side persistence means config and wallpaper are host-authoritative and
  multi-device.
- Settings panel and visuals are applied defensively inside `try/catch`; a failure
  in one surface does not crash the whole WebUI.

## 12. Tests

Three Node test suites (no browser, no server required):

| File | Scope |
|---|---|
| `test/host-smoke.mjs` | Host `apply` + routes against a throwaway `DSH_HOME`: config GET/POST + sanitization, `originalPreference`-free full-config normalization, background upload/serve (byte-identical), unsupported MIME rejection, traversal 400, missing 404, on-disk persistence. |
| `test/lifecycle.mjs` | Client authoritative-store semantics: default merge, no NaN/undefined, remount hydrates from `currentConfig` (not `DEFAULT_CONFIG`), repeated close/open, reload restores persisted config. |
| `test/no-appearance.mjs` | Source + logic check that the plugin never calls `theme.setTheme`, has no `appearance`/`originalPreference` fields, still uses `overrideTokens`, and recomputes tokens on `theme/change` without changing the native color mode. |

Run all: `node test/host-smoke.mjs && node test/lifecycle.mjs && node test/no-appearance.mjs`

The tests are state-model / host-level; real browser rendering is validated
manually (Settings UI, wallpaper, glass, accent across Light/Dark).
