# Color schemes

## Goal

The user picks a grey scheme in the preferences. The accent colors (blue, green, yellow, cream, orange, red, purple,
menuActive) stay the same in every scheme. Only the eleven neutral colors change.

## Today

1. `packages/studio/enums/src/Colors.ts` defines the neutrals as getters `neutral(saturation, lightness)` and uses
   the scheme hue plus a saturation multiplier.
2. `StudioSettings.appearance` holds `neutral-hue` (197) and `neutral-saturation` (100).
3. `boot.ts` subscribes to `appearance`, calls `setColorScheme` and then `initializeColors` on every surface, which
   writes `--color-*` CSS variables. The manual (`app/manual/src/main.tsx`) reads the same settings.
4. TS code that paints on canvases reads the `Colors.*` getters at paint time, so it follows a scheme change as soon
   as it repaints.

## Schemes

Each value is `saturation, lightness` at the fixed neutral hue 197.

| Color                 | classic (default) | modern (Massive XL greys) | contrast (bright light) |
|-----------------------|-------------------|---------------------------|-------------------------|
| bright                | 5, 100            | 0, 100                    | 10, 100                 |
| gray                  | 31, 91            | 0, 70                     | 10, 94                  |
| dark                  | 15, 84            | 0, 58                     | 10, 88                  |
| shadow                | 10, 60            | 0, 39                     | 10, 73                  |
| black                 | 10, 30            | 0, 24                     | 10, 50                  |
| background            | 8, 9              | 0, 13                     | 10, 19                  |
| panelBackground       | 14, 12            | 0, 15                     | 10, 21                  |
| panelBackgroundBright | 13, 16            | 0, 20                     | 10, 29                  |
| panelBackgroundDark   | 14, 11            | 0, 12                     | 10, 19                  |
| headerBackground      | 14, 3             | 0, 18                     | 10, 10                  |
| footerBackground      | 14, 9             | 0, 11                     | 10, 10                  |

The modern values come from the pixels of the Massive XL screenshot. Text: white titles 100, values and headings 70,
labels 58, dimmed numbers 39. Surfaces: knob bodies and pills 24, top bar 18, module panels 15, bottom bar 11.

Contrast is for sunlight or a dim screen. It has a light cool tint, much brighter text (labels 88, dimmed numbers
73), brighter surfaces (panels 21), and controls (50) that stand 29 above the panels. The header and footer (10) are
darker than the background (19).

## Implementation

Done (uncommitted):

1. `Colors.ts`: `ColorSchemes = ["classic", "modern", "contrast"]`, `ColorScheme` is one of those names and
   `DefaultColorScheme` is `"classic"`. The table above lives in `Neutrals`, and the neutral getters look up the
   active scheme. `setColorScheme(name)` replaces the old `setColorScheme({hue, saturation})`, which is a breaking
   change for SDK users of `studio-enums`.
2. `StudioSettings.appearance`: `"color-scheme": z.enum(ColorSchemes).catch(DefaultColorScheme)` replaces
   `neutral-hue` and `neutral-saturation`. Old settings load as classic, and zod drops the two old keys.
3. `boot.ts` and the manual's `readColorScheme` pass the scheme to `setColorScheme`.
4. `PreferencePanel` takes `dropdowns` (same shape as `options`) and renders a `DropDown` for those string fields.
   `PreferencesPageLabels.StudioSettingsDropdowns` lists Classic, Modern and High Contrast under Appearance.
5. `studio-enums` and `studio-core` are rebuilt. `tsc --noEmit` passes for studio, manual and core.

## Checks

1. 28 sass files in `app/studio/src` contain literal `hsl(` / `rgb(` / `#hex` colors. Each one is either an accent
   (fine) or a hard-coded grey that ignores the scheme. List the greys and move them to `--color-*` variables in
   a separate pass, before or with this change.
2. Canvas painters that cache a color at construction keep the old scheme until reload. Search for `Colors.` stored
   in fields or constants (`const x = Colors.dark.toString()` at module level) and turn them into reads at paint time.
3. Places that derive colors from neutrals (`Colors.dark.opacity(..)`, `.brightness(..)`) must still look right on
   the lighter modern surfaces. Check the timeline, mixer, device panels, menus, dialogs and the footer.
4. Contrast: modern text is darker (70 instead of 91), so check small labels on panelBackground (15).
5. WebCLAP device panels and script views get `--color-*` through `initializeColors` on their surface. Verify they
   update on a switch without reopening.

## Open questions

1. Should the scheme ship for every user, or stay behind a dev or beta flag until the sass greys are cleaned up?
2. Are more schemes planned right away (such as a lighter one), or only classic, modern and contrast?
