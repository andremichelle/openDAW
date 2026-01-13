import {Key, Shortcut} from "@moises-ai/lib-dom"

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