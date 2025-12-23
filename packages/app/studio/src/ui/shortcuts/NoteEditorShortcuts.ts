import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"

export const NoteEditorShortcutsFactory = ShortcutValidator.validate({
    "move-cursor-right": {
        shortcut: Shortcut.of(Key.ArrowRight),
        description: "Move playback cursor right"
    },
    "move-cursor-left": {
        shortcut: Shortcut.of(Key.ArrowLeft),
        description: "Move playback cursor left"
    },
    "zoom-to-content": {
        shortcut: Shortcut.of(Key.Backslash),
        description: "Zoom to content"
    }
})

export const NoteEditorShortcuts = ShortcutDefinitions.copy(NoteEditorShortcutsFactory)