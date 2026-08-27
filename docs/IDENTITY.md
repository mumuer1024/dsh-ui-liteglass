# dsh-ui-liteglass — Canonical Identity Record

Single source of truth for the public identity of this project. Update this file
whenever any of these values changes.

## Identity

| Field | Value | Notes |
|---|---|---|
| npm package | `dsh-ui-liteglass` | `package.json` `name`; the `dsh plugin add` package name |
| GitHub repository | `mumuer1024/dsh-ui-liteglass` | canonical source |
| display name | **LiteGlass** | brand used in README / storefront cards |
| plugin id | `dsh-ui-liteglass` | client module id, `settings.section` id, theme override source |
| rowId / wiring.id | `ui-liteglass` | loader entry id in `cordis.patch.yml`; used by skin markets for mutual-exclusion wiring |
| route prefix | `/ui-liteglass/*` | host API routes (config / state / background / backgrounds) |
| data directory | `$DSH_HOME/ui-liteglass/` | plugin config + uploaded backgrounds |
| CSS variable prefix | `--dsh-liteglass-*` | namespaced custom properties |
| DOM / data prefix | `dsh-ui-liteglass-*` / `[data-dsh-ui-liteglass=...]` | background layer + injected `<style>` tags |

## Market-facing correspondence

- **awesome-dsh-plugin**: category `theme` (Themes & Appearance). Entry file
  `data/plugins/mumuer1024__dsh-ui-liteglass.yml`. Install command shown as
  `dsh plugin --profile web add dsh-ui-liteglass` once published to npm, or
  `github:mumuer1024/dsh-ui-liteglass` otherwise.
- **kingOfSoySauce/dsh-skin-market**: registry entry pins the install target to a
  full 40-char commit SHA; `rowId` must equal the `cordis.patch.yml` loader entry
  id (`ui-liteglass`); preview images are real in-repo screenshots referenced by
  fixed-commit `raw.githubusercontent.com` URLs; license and a declared DSH
  compatibility range are required.

## Why plugin id and rowId differ

`plugin id` is the package-level identity: the client module id, the
`settings.section` id, and the theme-override source id are all `dsh-ui-liteglass`.
`rowId` is the short skin-market wiring id — the loader entry id (`ui-liteglass`)
that skin markets use to disable/enable skins on switch. They live in different
namespaces, so `dsh-ui-liteglass` + `ui-liteglass` as one paired identity is
intentional and stable.
