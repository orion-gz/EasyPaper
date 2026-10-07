# Custom themes

Settings → General → Screen theme contains a searchable catalog of 32 bundled palette adaptations and locally saved custom themes. Research and general documents each retain independent light and dark selections. The existing appearance toggle switches between those saved selections.

Selecting or editing a theme changes only the preview. **Apply** saves the theme and selects it for the editing slot. Editing an inactive slot does not change the active app appearance. Changing a built-in palette creates a custom theme; use Duplicate to keep another version of an existing custom theme. Renaming a custom theme retains its ID and all slot references. A shared custom theme affects every slot using it, shown above the editor. Deleting it resets its references to the corresponding EasyPaper default.

Color controls accept `#RRGGBB` and `#RRGGBBAA`; the slider changes opacity. Reset color removes an override, restoring inheritance. Reset theme restores its base preset. Low text contrast is advisory. The preview includes library, reader/translation, and chat surfaces, selected controls, input focus, buttons and status colors. PDF pixels, external websites, existing annotations and data-category colors remain source content.

Import JSON loads a new draft. Apply saves it with a fresh ID. Export JSON includes resolved colors rather than a dependency on the source preset, so the file is portable. Imported names render as text, and only registered color tokens are accepted. Theme credits and bundled license notices are available at `/theme-licenses/index.html`.

## Storage and integration

`easypaper_custom_themes_v1` holds one versioned document:

```json
{
  "version": 1,
  "selections": {
    "research": { "light": "easypaper-light", "dark": "catppuccin-mocha" },
    "general": { "light": "github-light", "dark": "easypaper-dark" }
  },
  "themes": [
    {
      "id": "a-generated-uuid",
      "name": "My theme",
      "scheme": "dark",
      "basePresetId": "nord",
      "overrides": { "sidebar-bg": "#123456" }
    }
  ]
}
```

The existing `easypaper_theme_research` and `easypaper_theme_general` preferences retain the active light/dark choice. On first use, legacy mode/global accent colors become custom EasyPaper themes for both appearances. Existing keys are preserved but no longer written by the new editor. Invalid stored references fall back to the corresponding EasyPaper default; malformed colors are discarded. Storage failures leave the applied theme unchanged. Cross-window changes apply to the app immediately; an open local draft is preserved and must be discarded/reloaded before it can replace newer data.

Portable JSON uses `{ version: 1, name, scheme, colors }`, with every key in `EDITABLE_TOKENS` present. Unsupported versions, missing/unknown tokens, malformed colors and files over 100 KB are rejected.

`themes/themeEngine.js` resolves preset colors, common overrides, derived accent tokens and region overrides. `applyTheme` writes a complete token set to a target element. The editor preview uses the same function as the app. Region selectors in `themes/themes.css` connect the tokens to live components. `documentWorkspaceRuntime.syncAppearance` copies the resolved host token set to every reader frame. Tauri's native window uses the selected appearance and background.

To add a preset, add its palette and stable ID to `themes/presets.js`, provide its upstream source and bundled license notice, and update the catalog count assertion. To add an editable role, register it in `COLOR_GROUPS`, supply its resolved default, connect the CSS consumers, and add English/Korean labels and developer context.

## Validation

- `npm run test:unit`: palette completeness, migration, inheritance, deletion, persistence errors and portable JSON validation.
- `npm run build`: translation validation and production bundle.
- `npx playwright test tests/e2e/custom-themes.spec.js`: draft isolation, four slots, CRUD, import/export, storage conflicts, keyboard navigation, scaling, all presets and reader-frame synchronization.
- Repeat the browser suite with `--config playwright.webkit.config.js` for WebKit.
- Native titlebar appearance should also be checked on a packaged Tauri app; browser tests do not exercise the operating system window APIs.

## Palette adaptation and regression coverage

Bundled themes preserve their own success, warning, error, information and selection colors. Diagnostics are preferred where provided; otherwise ANSI/chart or named palette colors are mapped to the corresponding application role. One uses its syntax hues, Catppuccin uses green/yellow/red/blue and surface2, and Ayu uses its named palette and editor selection. GitHub status colors use its classic palette. These are EasyPaper adaptations, not pixel-identical editor skins. EasyPaper defaults retain their original status colors. Changing the accent derives fresh selection colors; explicit selection/region overrides still take precedence.

The semantic palette snapshot was checked against these upstream files on 2026-10-06 (licenses remain bundled under `public/theme-licenses`):

- [catppuccin-latte, catppuccin-mocha, catppuccin-frappe, catppuccin-macchiato](https://raw.githubusercontent.com/catppuccin/palette/main/palette.json)
- [one-dark](https://raw.githubusercontent.com/atom/one-dark-syntax/master/styles/colors.less)
- [one-light](https://raw.githubusercontent.com/atom/one-light-syntax/master/styles/colors.less)
- [nord](https://raw.githubusercontent.com/nordtheme/visual-studio-code/develop/themes/nord-color-theme.json)
- [tokyo-night](https://raw.githubusercontent.com/enkia/tokyo-night-vscode-theme/master/themes/tokyo-night-color-theme.json)
- [tokyo-storm](https://raw.githubusercontent.com/enkia/tokyo-night-vscode-theme/master/themes/tokyo-night-storm-color-theme.json)
- [tokyo-day](https://raw.githubusercontent.com/enkia/tokyo-night-vscode-theme/master/themes/tokyo-night-light-color-theme.json)
- [rose-pine](https://raw.githubusercontent.com/rose-pine/vscode/main/themes/rose-pine-color-theme.json)
- [rose-moon](https://raw.githubusercontent.com/rose-pine/vscode/main/themes/rose-pine-moon-color-theme.json)
- [rose-dawn](https://raw.githubusercontent.com/rose-pine/vscode/main/themes/rose-pine-dawn-color-theme.json)
- [everforest-dark](https://raw.githubusercontent.com/sainnhe/everforest-vscode/master/themes/everforest-dark.json)
- [everforest-light](https://raw.githubusercontent.com/sainnhe/everforest-vscode/master/themes/everforest-light.json)
- [night-owl](https://raw.githubusercontent.com/sdras/night-owl-vscode-theme/main/themes/Night%20Owl-color-theme.json)
- [light-owl](https://raw.githubusercontent.com/sdras/night-owl-vscode-theme/main/themes/Night%20Owl-Light-color-theme.json)
- [monokai](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-monokai/themes/monokai-color-theme.json)
- [solarized-dark](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-solarized-dark/themes/solarized-dark-color-theme.json)
- [solarized-light](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-solarized-light/themes/solarized-light-color-theme.json)
- [dracula](https://raw.githubusercontent.com/dracula/visual-studio-code/master/src/dracula.yml)
- [github-dark, github-light](https://raw.githubusercontent.com/primer/github-vscode-theme/main/src/classic/colors.json)
- [gruvbox-dark, gruvbox-light](https://github.com/jdinhlife/vscode-theme-gruvbox/blob/master/src/shared.ts)
- [ayu-dark](https://github.com/ayu-theme/ayu-colors/blob/master/themes/dark.yaml)
- [ayu-mirage](https://github.com/ayu-theme/ayu-colors/blob/master/themes/mirage.yaml)
- [ayu-light](https://github.com/ayu-theme/ayu-colors/blob/master/themes/light.yaml)
- [vscode-dark, vscode-light](https://github.com/microsoft/vscode/tree/main/src/vs/platform/theme/common/colors)

Regression tests exercise actual computed colors on all 32 active presets, Light/Dark shell surfaces, selected document cards, active tabs, translation text/borders and reader chat backgrounds. Draft-copy deletion and independent invalid-input preservation are also covered. The macOS WebKit CI job includes both custom theme and legacy preference migration scenarios. Focus mode retains transparent sentence backgrounds.

For native release validation, open a packaged Tauri app, apply a custom Light and Dark background, switch workspace modes, open/reopen reader tabs and restart the app. Verify the native titlebar appearance, window background and saved theme on each supported OS; Playwright cannot certify native window APIs.
