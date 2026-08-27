# Screenshots — capture guide

Real, committed screenshots of the plugin in action. These power storefront cards
in [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
and [kingOfSoySauce/dsh-skin-market](https://github.com/kingOfSoySauce/dsh-skin-market).

## What to capture (required)

1. **`preview.webp`** — main DSH Web UI with a custom wallpaper + glass-like panels
   + an accent color applied (light mode).
2. **`settings.webp`** — the plugin's section under **Settings → Appearance**
   (Background / Panel transparency / Accent color).
3. **`dark.webp`** — dark mode: accent color + glass surfaces under the native
   Dark scheme.

Optional: `wallpaper.webp` — the wallpaper upload / background controls.

## Format and size

- Format: **WebP preferred** (PNG/JPEG acceptable). No SVG, no data URIs.
- Size: at least **1280 px wide**, landscape (16:10 or 4:3) — storefront cards are
  landscape.
- Keep each file reasonably small (target < 500 KB); images are served raw from
  GitHub.

## How they are wired up

1. Commit the images under this directory with the fixed filenames above.
2. Create `screenshots.json` at the **repo root** (beside `package.json`) from the
   template [`screenshots.json.example`](../../screenshots.json.example) — an
   array of relative paths, 1–8 entries.
3. Done. awesome-dsh-plugin reads `screenshots.json` at HEAD; the skin market
   reads the images at the pinned commit via raw URLs.

Rules both markets enforce:

- Images must be **real screenshots in this repository** — no external image
  hosts, no placeholders, no tracking-parameter URLs.
- Relative paths in `screenshots.json` resolve against the repo, so renaming a
  file breaks visibly (that is the point).
- No screenshots yet? Storefronts fall back to extracting images from the README —
  declaring `screenshots.json` just gives you control over order and selection.
