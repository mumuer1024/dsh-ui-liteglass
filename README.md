# dsh-ui-appearance

English | [简体中文](README.zh-CN.md)

A lightweight appearance plugin for DeepSeek Harness.

**Wallpaper. Glass. Accent. That's it.**

## Preview

Screenshots to be added before release:

- `preview.webp` — main interface with a custom wallpaper, glass-like panels, and an accent color
- `settings.webp` — the plugin's Appearance settings area

## Features

1. **Custom Wallpaper**
   - Remote image URL, or upload a local image
   - Adjustable background opacity and background blur

2. **Glass-like Panels**
   - Adjustable panel transparency for a lightweight glass-like look

3. **Accent Color**
   - Customize the accent color used across supported DSH interface states
   - Adapts automatically to DSH's native Light / Dark appearance

## Philosophy

`dsh-ui-appearance` is deliberately small, focused, and predictable.

- It does **not** build a second theme system.
- It does **not** replace the DSH native Appearance settings.
- Light / Dark / System is managed entirely by DSH native settings. The plugin
  never modifies the native color mode.
- It starts with a native experience by default — appearance is only enhanced
  when you configure it.

## Compatibility

Tested with DeepSeek Harness 0.1.0-rc.7.

DeepSeek Harness is still evolving quickly, so a future release may change plugin
interfaces.

## Installation

Install directly from the GitHub repository (via the pnpm-based `dsh plugin add`):

```sh
dsh plugin --profile web add git+https://github.com/mumuer1024/dsh-ui-appearance.git
dsh --profile web
```

To pin a specific release, add the tag:

```sh
dsh plugin --profile web add 'git+https://github.com/mumuer1024/dsh-ui-appearance.git#v0.1.0'
```

`dsh plugin add` initializes the profile on first use and wires the bundle
automatically. After that, start the Web UI and open **Settings → Appearance**.

## Configuration

Open **Settings → Appearance** (the plugin adds its own section there):

- **Background**: Off / URL / local upload; background opacity; background blur.
- **Panel transparency**: how translucent the main surfaces are.
- **Accent color**: pick a color, or reset to the native value.

Changes are saved to the server and shared across devices that reach the DSH host.

## Uninstallation

```sh
dsh plugin --profile web remove dsh-ui-appearance
```

Removing the plugin restores the original appearance. Note that uploaded
wallpaper files and the plugin config under `$DSH_HOME/ui-appearance/` are not
removed by the uninstall command — delete that directory manually if you want
them gone.

## Known Limitations

- **Panel blur (`backdrop-filter`) is currently not enabled.** Applying a
  backdrop blur to the main panel containers breaks Settings / overlay
  positioning in the current build, so that effect is disabled. Background blur
  and panel transparency are functional and are not affected.
- The color mode (Light / Dark / System) is always controlled by DSH native
  settings — this plugin does not provide a color-mode switch.

## Development / Testing

Automated Node test suites cover the host routes, the client state model, and the
no-color-mode guarantee:

```sh
node test/host-smoke.mjs && node test/lifecycle.mjs && node test/no-appearance.mjs
```

See `docs/ARCHITECTURE.md` for design details.

## License

[MIT](LICENSE)
