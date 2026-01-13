import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@moises-ai/lib-dom"

const shift = true

export const NoteEditorShortcutsFactory = ShortcutValidator.validate({
    "increment-note-semitone": {
        shortcut: Shortcut.of(Key.ArrowUp),
        description: "Move note up by one semitone"
    },
    "decrement-note-semitone": {
        shortcut: Shortcut.of(Key.ArrowDown),
        description: "Move note down by one semitone"
    },
    "increment-note-octave": {
        shortcut: Shortcut.of(Key.ArrowUp, {shift}),
        description: "Move note up by one octave"
    },
    "decrement-note-octave": {
        shortcut: Shortcut.of(Key.ArrowDown, {shift}),
        description: "Move note down by one octave"
    },
    "increment-note-position": {
        shortcut: Shortcut.of(Key.ArrowRight),
        description: "Move note forwards"
    },
    "decrement-note-position": {
        shortcut: Shortcut.of(Key.ArrowLeft),
        description: "Move note backwards"
    },
    "toggle-step-recording": {
        shortcut: Shortcut.of(Key.KeyS),
        description: "Toggle step recording"
    }
})

export const NoteEditorShortcuts = ShortcutDefinitions.copy(NoteEditorShortcutsFactory)