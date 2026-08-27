# Screenshots — capture guide

Real screenshots of the plugin in action, powering storefront cards in
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
[kingOfSoySauce/dsh-skin-market](https://github.com/kingOfSoySauce/dsh-skin-market)
and this README.

## Current set (committed)

| File | Scene |
|---|---|
| `preview-light.webp` | light main interface — wallpaper + glass panels + accent |
| `preview-dark.webp` | dark main interface — same surfaces under the native Dark scheme |
| `settings-light.webp` | light Appearance settings (background / panel / accent controls) |
| `settings-dark.webp` | dark Appearance settings |

All are 2560×1279 (2:1) WebP at quality 90, 54–67 KB each — full-resolution
captures of the running plugin, no resizing, cropping, or editing.

## How they are wired up

1. `screenshots.json` at the **repo root** (beside `package.json`) lists these
   files by relative path (1–8 entries). awesome-dsh-plugin reads it at HEAD; the
   skin market references the images at its pinned commit via raw URLs.
2. README embeds the two mode previews plus one settings shot; the full set stays
   in this directory.

Rules both markets enforce:

- Images must be **real screenshots in this repository** — no external image
  hosts, no placeholders, no tracking-parameter URLs.
- Relative paths in `screenshots.json` resolve against the repo, so renaming a
  file breaks visibly (that is the point).

## Adding / updating captures

- Replace the WebP in this directory (keep the filename) and keep the aspect
  ratio — do not crop important UI.
- Re-validate `screenshots.json` after any change; keep each file reasonably
  small (target < 500 KB; the current set is well under that).
