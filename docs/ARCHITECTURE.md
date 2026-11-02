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
  entry (`id: ui-liteglass`, `inject: [webServer, settings, connection]`).
- `dsh.client` declares `{ platform: "web", inject: ["@deepseek-ai/dsh-client-ui-theme"] }`.
  The `inject` here is the client-side dependency ordering — the theme client
  bundle must be active before this plugin's client.
- `exports["."]` → `lib/index.js` (host apply), `exports["./client"]` →
  `lib/client.js` (served by client-modules at `/plugins/dsh-ui-liteglass/client.js`).

The client is adopted by the Cordis client runner: service access is gated by the
returned `inject` array (`exports.inject = ['slots', 'theme']`).

Two facts about that runner matter here, and only one of them is a convenience:

- A **bundle-declared** client module (this package) is loaded *statically*; the
  runner does **not** wrap it in the dynamic-package facade. In particular
  `theme.overrideTokens` is the plain service call: it returns a disposer that
  **the plugin owns**. Nothing pins the source or hangs the disposer on the fiber
  for us, so `apply()` keeps that disposer in `themeDispose` and releases it from a
  `ctx.effect` teardown — otherwise the layer would outlive an unload.
- `theme.setTheme` is intentionally never used (`test/no-appearance.mjs` enforces
  this against the real source).

## 3. Host routes

Registered on the DSH `webServer` service (`webServer.register`):

| Route | Kind | Purpose | Auth |
|---|---|---|---|
| `GET/POST /ui-liteglass/config` | exact | read / write the plugin config JSON | session |
| `GET /ui-liteglass/state` | exact | expose the native theme preference via `settings.describe()` (read-only; the plugin never changes it) | session |
| `POST /ui-liteglass/background` | exact | accept an uploaded wallpaper image (raw body, content-type + magic-byte checked) | session + same origin |
| `GET /ui-liteglass/backgrounds/*` | prefix | serve stored wallpaper files | session |

**Authentication.** DSH 0.2.x authenticates per route — only the index
(`connection.authorizeIndex`) and `/api` (`connection.admit`) are covered by the
harness gate, so a plugin route is public unless it checks
`connection.isAuthenticated(req)` itself. Every route above does, and answers 401
JSON (or 401 text for the image route) when the caller has no session. Writes
additionally require a JSON content type (which cross-origin callers cannot send
without a preflight) and an `Origin` whose host equals the request `Host`
(`sameOrigin()`), so a form/text-plain post or a cross-site form cannot rewrite
the config.

**Lifecycle.** Every `webServer.register` call is wrapped in `ctx.effect`, so
unloading the plugin releases the route. This matters for `patchReload: "live"`:
a live patch that re-applies the plugin would otherwise throw
`duplicate exact route` on the second registration.

Route notes:

- `webServer` matches prefix routes via `pathname.startsWith(prefix + "/")`, so
  the `backgrounds` prefix is registered **without** a trailing slash (a trailing
  slash would double into `"//"` and never match).
- Stored background filenames are `sha1(content)[0:16] + ext`, validated against
  `^[0-9a-f]{16}\.(png|jpg|webp|gif)$` **before** any path join. Anything else
  (path traversal, bogus names) → 400; a well-formed but missing file → 404.
- Upload MIME types are whitelisted (`png/jpeg/webp/gif`); anything else is
  rejected (e.g. `svg` is excluded deliberately).
- The declared content type must **agree with the bytes**: the body is sniffed
  for a PNG/JPEG/GIF/WebP signature, so a lying content type cannot store an
  arbitrary file under an image name.
- The upload body is read with a hard 8 MiB ceiling enforced *while streaming*
  (`readLimitedBody`), so an oversized client is rejected with 413 instead of
  being buffered first. Unreferenced, older-than-1h background files are pruned
  after a successful write, which keeps the directory bounded.

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
- Config schema: `background` (`off|url|local`), `backgroundImage`,
  `backgroundOpacity` (0–1), `backgroundBlur` (0–40), `panelOpacity` (0–1),
  `panelBlur` (0–40), `accentColor` (hex or empty), `accentButtons` (boolean,
  default `false`).
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

- **Glass**: when a wallpaper is active or `panelOpacity < 1`, a **surface
  ladder** is overridden to translucent `rgba(...)`:
  `--dsw-alias-bg-base` → `--dsw-specific-sidebar-fill` →
  `--dsw-alias-bg-layer-1` → `--dsw-alias-bg-module-platform` →
  `--dsw-specific-selector` → `--dsw-alias-bg-layer-2` →
  `--dsw-specific-input-major` → `--dsw-alias-bg-layer-3` →
  `--dsw-alias-bg-overlay` → `--dsw-specific-menu`.
  Each step is slightly **more opaque** than the previous one, so nesting still
  reads as depth above the wallpaper instead of collapsing into one flat tone
  (DSH 0.2.x encodes depth with three distinct raised surface tones). A wallpaper
  forces a translucency ceiling (≤ 0.85) so the image shows through.
- **Accent**: when `accentColor` is set, emphasis tokens are overridden —
  `--dsw-alias-state-business-primary`,
  `--dsw-specific-sidebar-nav-item-active-accent`,
  `--dsw-alias-interactive-bg-hover-accent` and the static palette tones
  `--dsw-static-deepseek-500/400` (which feed link, info-button and business
  aliases).
- **Primary button is opt-in.** `--dsw-alias-brand-primary` is monochrome in DSH
  0.2.x (near-black in light, near-white in dark), so recoloring it is a separate
  `accentButtons` switch, default **off**. When on, it is paired with
  `--dsw-alias-label-primary-foreground` chosen from the accent's relative
  luminance (light accent → dark text), instead of assuming white always reads.
- Reusing a `{light,dark}` override through the native token system deliberately
  avoids building a second theme system.

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
| settings seat id (`settings.general.item`) | `dsh-ui-liteglass` |
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

Four Node test suites (no browser, no server required):

| File | Scope |
|---|---|
| `test/host-smoke.mjs` | Host `apply` + routes against a throwaway `DSH_HOME`: 401 for every route without a session, config GET/POST + sanitization + content-type/Origin rejection, `settings.describe()`-based state, upload/serve (byte-identical), MIME + magic-byte rejection, 413 over the streamed limit, traversal 400, missing 404, unreferenced-file pruning, `dispose()` releasing every route. |
| `test/client-contract.mjs` | Runs the real `lib/client.js` `apply()` in a VM with a DOM stub: registers into `settings.general.item` (no second Appearance page), token pairs carry `{light,dark}`, surface alpha climbs monotonically with depth, `brand-primary` stays untouched unless `accentButtons` (and is then paired with a readable foreground), wallpaper node precedes `#root`, `theme/change` recomposes without `setTheme`, unload retires the layer and removes the node. |
| `test/lifecycle.mjs` | Client authoritative-store semantics: default merge, no NaN/undefined, remount hydrates from `currentConfig` (not `DEFAULT_CONFIG`), repeated close/open, reload restores persisted config. |
| `test/no-appearance.mjs` | Source + logic check that the plugin never calls `theme.setTheme`, has no `appearance`/`originalPreference` fields, still uses `overrideTokens`, and recomputes tokens on `theme/change` without changing the native color mode. |

Run all: `npm test`

The tests are state-model / host-level; real browser rendering is validated
manually (Settings UI, wallpaper, glass, accent across Light/Dark).
