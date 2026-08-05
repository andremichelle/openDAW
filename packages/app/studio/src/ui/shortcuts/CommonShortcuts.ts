import {Key, Shortcut} from "@opendaw/lib-dom"

export namespace CommonShortcuts {
    const shift = true
    const ctrl = true

    export const Position = {
        "position-increment": {
            shortcut: Shortcut.of(Key.ArrowRight),
            description: "Move playback position forwards"
        },
        "position-decrement": {
            shortcut: Shortcut.of(Key.ArrowLeft),
            description: "Move playback position backwards"
        }
    }

    export const Snapping = {
        "snapping-finer": {
            shortcut: Shortcut.of(Key.Comma, {shift}),
            description: "Use a finer snapping grid"
        },
        "snapping-coarser": {
            shortcut: Shortcut.of(Key.Period, {shift}),
            description: "Use a coarser snapping grid"
        }
    }

    export const Selection = {
        "select-all": {
            shortcut: Shortcut.of(Key.KeyA, {ctrl}),
            description: "Select all"
        },
        "deselect-all": {
            shortcut: Shortcut.of(Key.KeyA, {ctrl, shift}),
            description: "Deselect all"
        },
        "delete-selection": {
            shortcut: Shortcut.of(Key.DeleteAction),
            description: "Delete selection"
        }
    }
}