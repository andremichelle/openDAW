# Zeitgeist Grooves

Zeitgeist was meant to host any groove function, not only the fixed shuffle. Grooves become project resources
that can be shared, stacked and edited in one place, like modulators.

## Groove model

1. A groove maps one cell of musical time onto itself with a monotonic increasing function `f`, `f(0) = 0` and
   `f(1) = 1`. The cell length is the groove's duration.
2. Amount blends the function.
    1. 50% is straight, `y = x`.
    2. 100% is the function, `y = f(x)`.
    3. 0% is the function mirrored on `y = x`, which is its inverse `y = f⁻¹(x)`.
    4. Above 50%: `y = x + (2a - 1)(f(x) - x)`. Below 50%: `y = x + (1 - 2a)(f⁻¹(x) - x)`.
    5. A blend of two increasing curves through (0,0) and (1,1) is again one, so every amount stays valid.
3. Every function is baked into a lookup table when a parameter changes. Warp and unwarp interpolate the
   table in both directions, like `QuantisedGrooveFunction` in lib-dsp. No function needs a closed inverse.
4. Every groove type uses one duration list: 1/16, 1/8, 1/4, 1/2, 1, 2, 4, 8 and 16 bars. Duration
   is a dropdown, not a knob.
5. Groove parameters are neither automatable nor modulatable. Changing a curve within a cell can move notes
   backwards in time.
6. Power and S-curve have no Shape parameter. Their curve at 100% amount is fixed (exponent 4), amount covers
   the range.

## Groove types

1. **Shuffle**: the existing `GrooveShuffleBox` with its Moebius curve. It stays exactly as it is, old projects
   play identically.
2. **Function**: a choice of curves sharing amount and duration.
    1. Power: rushes or drags across the whole cell.
    2. S-curve: pulls towards or pushes away from the middle of the cell.
    3. More can be added without new box types.
3. **Random**: the monotonic random sequence from carbon's `GrooveRandom` with seed (dice like the Arpeggio),
   roughness, adjustable steps per cell and amount. Amount replaces carbon's strength.
4. **Stack**: an ordered list of grooves applied one after another. Warp runs first to last, unwarp last to
   first. A stack must never contain itself (cycle check on every assignment).

## Sharing

1. The project holds a groove collection in the RootBox, like `modulators`.
2. The global shuffle is the existing `rootBox.groove`. It is always there, cannot be deleted, uses the Shuffle
   curve at 1/8 and is listed first.
3. A groove can be used by any number of targets. Targets are Zeitgeist devices, tracks and regions are postponed.
4. A target may have no groove. The Zeitgeist groove pointer becomes optional and Zeitgeist then passes events
   through unchanged. The Zeitgeist groove dropdown offers None.
5. A new Zeitgeist starts on the global shuffle.
6. **Make unique** replaces the shared groove of one target with a real copy.
7. Deleting a groove that is in use asks the user to either fall back to the global shuffle or remove it from
   its targets.
8. Copy, paste and presets of a Zeitgeist: within one project the copy keeps the same groove. Into another
   project or as a preset, the global shuffle maps to that project's global shuffle and any other groove comes
   along as a new, unshared groove.

## UI

Preview: `plans/zeitgeist-grooves-preview.html` (open it in a browser, knobs and dropdowns work).

1. **Groove editor**: one component used by both the Zeitgeist panel and the Grooves list.
    1. Height 176px, the device panel height. Three columns with fixed widths (11.5em, 8.5em, 15em), so no
       text, type or groove change moves anything.
    2. First column, top to bottom: groove dropdown (Zeitgeist only), shared line, Type dropdown, Duration
       dropdown, Seed. All dropdowns have a fixed width sized to their longest option.
    3. Shared line: "Shared by N" with a Make unique button, or "Not shared" with the button hidden in place.
    4. Seed: the seed number with a dice to reseed, Random only.
    5. Second column: knobs in a two column grid, each with a fixed place.
        1. Amount top left, centred at 50%.
        2. Shape (Power, S-curve) or Roughness (Random) top right. They never appear together.
        3. Steps (Random) below Amount.
    6. A type shows only the controls it uses. Shuffle has Amount only. Hidden fields in the first column keep
       their space.
    7. Stack: the knob area shows the ordered list of its grooves with an Add groove entry. Amount and
       Duration are not shown, every member has its own.
    8. Third column: the display.
        1. Curve over one cell, grid lines at musical subdivisions, the straight line `y = x` dashed.
        2. Timing strip below: one bar of 16ths (or one cell if longer), straight positions on top, warped
           positions below, joined by lines, cell boundaries marked.
2. **Zeitgeist**: the editor is the whole panel. The groove dropdown lists the global shuffle, every shared
   groove and New Groove.
3. **Grooves tab**: the modulation panel gets a tab bar, Modulators and Grooves. Each groove is a row with its
   name and type in the header, the editor without the groove dropdown, and a Used by list on the right.
   Every editor showing the same groove updates together.
    1. The header has a menu like the modulators: Replace with (another type), Duplicate, Delete.
    2. The Used by list looks like the modulators' target list, each target with a delete button that removes
       the groove from that target.
4. **Header**: the global shuffle amount next to the tempo. Its duration is edited in the Grooves list only.

## Scope

This round delivers the new Zeitgeist, the global shuffle and the Grooves tab, complete with every groove type,
sharing, Make unique, reassign, copy and delete. Grooves on tracks and regions are postponed to a later round.
The engine registry is still built so that tracks and regions can read from it later without a redesign.

## Phases

1. Boxes and migration: groove collection in the RootBox, Function, Random and Stack boxes, optional Zeitgeist
   groove pointer. Existing grooves (global and every Zeitgeist's own shuffle) move into the collection.
2. Adapters: lookup tables, blend, stack, cycle check. Tests for monotony, warp and unwarp round trips and an
   unchanged Shuffle curve.
3. Engine: a groove registry in the engine follows every groove type and stack. Zeitgeist reads its groove
   from the registry. Golden tests against today's output.
4. Groove editor component, then the new Zeitgeist panel with groove selector, shared marker and Make unique.
5. Grooves tab with target list, reassign, copy and delete dialog.
6. Global shuffle amount in the header.

## Engine mechanism (approved)

1. The engine keeps a groove registry built from the project's groove boxes, stacks included.
2. Devices get two new host imports, warp and unwarp, for the groove they point to. A device observes its groove
   pointer once in `init` and gets a slot id, the engine keeps the slot on the pointer's target.

## Postponed

1. Grooves on tracks and regions, including how they chain with a Zeitgeist groove.
2. Grooves for devices with their own sequencer, starting with Cubed. Its internal pattern is generated inside
   the device at straight 16ths, so an upstream Zeitgeist never reaches it. The device gets a groove selector
   like Zeitgeist (none or the global shuffle by default) and warps its own step positions through the engine
   registry.
3. Very late: grooves in all scriptable devices (Spielwerk, Werkstatt, Apparat). A script can select a groove
   and warp and unwarp positions through it, for example to swing the notes it generates.
4. Offset groove: moves every position by a fixed amount instead of bending a cell. Useful for laid back or
   pushed parts, and as a member of a stack. `GrooveOffsetBox` already exists in the schema, unused.

## To decide later

1. Orphans: when a target switches grooves, the old groove may have no users left. Keep it in the list or
   delete it. `GrooveShuffleBox` currently declares its pointer as mandatory, which matters here.
2. Make unique on a stack: copy only the stack or also every groove inside it.
