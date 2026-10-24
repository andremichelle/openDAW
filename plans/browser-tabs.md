# Browser Tabs

> **Status:** Phase 1 implemented (tabs + flat list of devices, presets and community scripts, one line each: icon + name). Uncommitted.

## TODO after phase 1

1. Racks and chains are not listed and cannot be saved by dropping onto the browser. The old drop logic lives in `CompoundItem.tsx`, deleted in the phase 1 change, restore it from `fe6910fae`.
2. Script drags (`DragScript`) land on the timeline, track headers and the device panel. Composite branch and layer rows do not take them yet, they do not take presets either.
3. Single click opens a details block under the row (caption, full description, hint), double-click creates. Hover cards were tried and dropped. Moving the preset menu actions into the details and a preview are still open.
4. The tour step "presets" still says "Presets" and points at the whole tab bar.
5. The mixins `library-item-header`, `library-item-states` and `library-preset-list` are unused now, keep them for the racks and chains rows or delete them.

## Goal

The Presets tab holds three categories, each with stock devices, nested presets and a compound row, so it gets crowded. Community scripts can only be found through Spotlight. The new browser:

1. Has five tabs: **Instruments**, **AudioFx**, **MidiFx**, **Samples**, **Soundfonts**.
2. Puts every kind of thing you can create into one flat A to Z list per tab: stock devices, presets, community scripts, racks and chains.
3. Creates a community script with one click: the matching script device is created and the script is compiled, so it acts like a stock device.
4. Keeps the search bar and the filters.

## 1. Tab bar

The panel is narrow, so the tabs use the category colour and a glyph and shrink to the glyph alone when there is no room.

```
wide (≥ 300px)
┌────────────────────────────────────────────────────┐
│ ●Instruments  ●AudioFx  ●MidiFx  ◌Samples  ◌Soundfonts   │
└────────────────────────────────────────────────────┘
   green    blue      orange   grey     grey

narrow (< 300px)
┌───────────────────────────┐
│ [♪] [≈] [⇄] [▤] [◎]       │   tooltip carries the full name
└───────────────────────────┘

while searching, other tabs show their hit count
┌────────────────────────────────────────────────────┐
│ ●Instruments  ●AudioFx³  ●MidiFx  ◌Samples¹²  ◌Soundfonts│
└────────────────────────────────────────────────────┘
```

`BrowseScope` becomes `{Instruments, AudioEffects, MidiEffects, Samples, Soundfonts}`. The old `Presets` value maps to `Instruments` when the stored layout is restored.

## 2. One flat list

Every row has the same shape: an icon, a name and a one-line brief. On the right, a **kind mark** shows what the row creates. Stock devices have no mark, so they look the cleanest.

```
┌ AudioFx ──────────────────────────────────────┐
│ [☁][👤][</>][⛓]  🔍 search…                    │
├───────────────────────────────────────────────┤
│ ⌁ Bitcrusher                                  │
│   Lo-fi sample rate and bit reduction         │
│ ⌁ Bitcrusher Dirty Drums           ◇ Bitcr.   │  preset: diamond + parent
│   Stock preset                                │
│ ⛓ Bus Glue                         ⛓ chain    │  chain: 3 devices
│   Compressor › EQ › Tidal                     │
│ ⌁ Comb Shimmer                     </> @tilo  │  community script
│   Six tuned combs with a slow shimmer feed…   │
│ ⌁ Compressor                                  │  stock
│   Classic feed-forward dynamics               │
│ ⌁ Delay                                       │
│   Tempo synced stereo delay                   │
│ ⌁ Delay                            </> @mia   │  same name, the mark tells them apart
│   Ping pong with diffusion in the feedback…   │
│ ⌁ Delay Dub Throw                  ◇👤 Delay   │  user preset
│ …                                             │
└───────────────────────────────────────────────┘
```

### Kind marks

| Mark | Kind | Click / drag |
|---|---|---|
| (none) | stock device | creates the device |
| `◇ Parent` | stock preset | creates the parent device with the preset applied |
| `◇👤 Parent` | user preset | same, from OPFS |
| `</> @author` | community script | creates Werkstatt / Apparat / Spielwerk and compiles the script |
| `⛓ chain` | effect chain preset | creates all devices in order |
| `▣ rack` | instrument rack preset | creates instrument + effects |

The preset rows use the parent device icon, so the eye groups by shape even when the sort does not.

### Sort: A to Z, with a second option

A purely alphabetical list scatters a device's presets ("Bass Pluck" under B, "Warm Pad" under W). That is fine while browsing by name, but painful when you want every Vaporisateur preset. Two sort modes, switched by clicking the list header:

```
 A–Z ▾                               by device ▾
 ─────────────────────────           ─────────────────────────
 ♪ Bass Pluck      ◇ Vapo.           ♪ Vaporisateur
 ♪ Nano                                 ◇ Bass Pluck
 ♪ Neon                                 ◇ Warm Pad
 ♪ Organ Stab      ◇ Neon               ◇👤 My Lead
 ♪ Playfield                          ♪ Nano
 ♪ Vaporisateur                       ♪ Neon
 ♪ Warm Pad        ◇ Vapo.              ◇ Organ Stab
```

"By device" is still flat. Presets are indented one step under their parent and there is no expand and collapse, so nothing is hidden. Typing a device name in the search also lists all of its presets in either mode, since the search matches the parent name.

## 3. Filters

The two existing toggles become four, one per source. At least one stays on, as today.

```
 [☁ stock] [👤 user] [</> community] [⛓▣ compounds]
```

Possible extras:

1. **Show presets**: a fifth toggle (◇) that hides all presets and leaves only the devices. This gives the clean old view back in one click.
2. A long press or right-click on a toggle makes it **solo** (only that source).

## 4. Racks and chains

Proposal: they are ordinary rows in the flat list, sorted by name, with the `⛓` / `▣` mark. Racks go into Instruments, audio chains into AudioFx and MIDI chains into MidiFx. The `⛓▣` filter hides them.

**Saving (drop targets)** is the open problem. Today you drop onto the "Chains" / "Racks" row or onto a device row. Without those rows, a **drop shelf** appears at the bottom of the list only while a device drag is active and works out what to save from what is being dragged:

```
idle                                 dragging 3 effects from a chain
┌───────────────────────────┐        ┌───────────────────────────┐
│ …list…                    │        │ …list…                    │
│                           │        │                           │
│                           │        ├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤
│                           │        ┆  ⛓  Save as chain preset  ┆
│                           │        ┆     3 audio effects       ┆
└───────────────────────────┘        └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘

 1 effect      → "Save as Delay preset"
 n effects     → "Save as chain preset"
 audio unit    → "Save as rack preset"
 wrong kind    → shelf shows the tab it belongs to: "Drop on AudioFx"
```

While you drag, hovering a tab for about 400 ms switches to it, so a MIDI chain can be saved while the Instruments tab is open. The drop onto a device row stays as a shortcut.

## 5. Descriptions: brief in the row, full text in a footer

Stock briefs are short and written for the row. Script descriptions can be paragraphs. The row only ever shows **one clamped line**. The full text goes into an **info footer** that follows hover and keyboard selection:

```
┌───────────────────────────────────────────────┐
│ ⌁ Comb Shimmer                     </> @tilo  │
│   Six tuned combs with a slow shimmer feed…   │ ◄ hover
│ ⌁ Compressor                                  │
│ …                                             │
╞═══════════════════════════════════════════════╡ ◄ drag to resize, collapsible
│ Comb Shimmer                       Werkstatt  │
│ by tilo · MIT · updated 3 days ago            │
│                                               │
│ Six tuned comb filters whose feedback is fed  │
│ through a pitch shifter one octave up. Use    │
│ low mix on pads, high mix on drums for metal  │
│ ringing. The Spread knob detunes the combs…   │ ◄ scrolls on its own
│                                               │
│ #reverb #shimmer #experimental                │ ◄ tags click into the search
│ [ Create ]  [ View source ]  [ GitHub ↗ ]     │
└───────────────────────────────────────────────┘
```

The footer content depends on the kind:

| Kind | Footer shows |
|---|---|
| stock | brief + a "Manual" link if the device has one |
| preset | parent device, author (user / stock), "Delete" / "Rename" for user presets |
| script | author, licence, updated, full description, tags, source, GitHub link |
| chain / rack | the device sequence as a small strip: `Compressor › EQ › Tidal` |

The brief of a script is the first sentence of `description`, cut at about 60 characters. An optional `brief` field in the commons index lets authors set it themselves later.

Option B, with no footer: a tooltip after a delay. It is cheaper but hides the actions and cannot scroll, so I recommend the footer.

## 6. Community script rows in detail

1. The source is `CommunityAPI` index, filtered by `target`: `apparat` → Instruments, `werkstatt` → AudioFx, `spielwerk` → MidiFx, `project` → not listed (those scripts stay in Spotlight / the code editor).
2. The icon is the target device icon (Apparat / Werkstatt / Spielwerk), so the row looks like a device.
3. Click and drag both go through the existing `SpotlightCreate.script` path. It is moved into a shared `ScriptDeviceCreation` so the browser and Spotlight use the same code. A drop onto a chain inserts at the drop index, like stock effects.
4. While the source loads, the row shows a small spinner in place of the mark. If loading fails, the existing notifier runs.
5. If the index is unreachable (offline), the `</>` filter shows a strike-through and the rows stay out. Nothing else changes.
6. Scripts that need a newer API are already hidden by `CommunityIndex.ApiLevel`.

## 7. Keyboard

The list becomes keyboard-navigable, because one flat list makes this possible:

```
 ↑ ↓      move the selection (the footer follows)
 Enter    create the selected item on the selected track
 ⌘F / /   focus the search
 ← →      previous / next tab
 Esc      clear the search
```

## 8. Phases

1. **Tabs + flat list for stock and presets.** Split `PresetBrowser` into one `DeviceListBrowser` per category, with the kind marks, the A–Z / by-device sort and the existing toggles. Racks and chains appear as rows. The drop onto the device row still works.
2. **Info footer.** Hover and selection, resize and collapse, kind-specific content.
3. **Community scripts.** Rows, the `</>` filter, shared creation with Spotlight.
4. **Drop shelf.** Replaces the compound drop targets, plus switching tabs while hovering during a drag.
5. **Keyboard + hit counts on the tabs.**

Each phase ends with a browser check by André before the next one starts.

## Open questions

1. Is the default sort A–Z or by device?
2. Footer (recommended) or tooltip for long descriptions?
3. Should `project` scripts show up anywhere in the browser, for example as a sixth "Scripts" tab, or stay in Spotlight only?
4. Do user preset folders (`plans/preset-folders.md`) still make sense in a flat list, or does the by-device mode plus search replace them?
5. Is the drop shelf acceptable as the only place to save chains and racks, or should a "Save chain" entry also go into the device panel context menu?
6. Tab labels: "Instruments / AudioFx / MidiFx / Samples / Soundfonts" as written, or glyph-only with tooltips everywhere?
