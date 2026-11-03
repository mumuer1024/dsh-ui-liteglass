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
| `settings-light.png` | light LiteGlass settings block (Settings → General) |
| `settings-dark.png` | dark LiteGlass settings block |

Full-resolution captures of the running plugin, no resizing, cropping, or
editing. The two mode previews are WebP at quality 90, 2560×1279 (2:1), ~68 KB
each. The two settings shots are PNG, 2560×1247 (≈2.05:1), 0.8–0.9 MB each —
PNG keeps the small UI text crisp, which matters most on the settings panel.
They are the heaviest files in the repo; nothing else here is large.

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

- Replace the image in this directory (keep the filename) and keep the aspect
  ratio — do not crop important UI.
- Re-validate `screenshots.json` after any change. The mode previews stay small
  (< 100 KB); a settings capture may be a ~1 MB PNG because legibility wins there.
