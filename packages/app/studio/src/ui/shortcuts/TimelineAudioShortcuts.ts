import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"

export const TimelineAudioShortcutsFactory = ShortcutValidator.validate({
    "revert-audio": {
        shortcut: Shortcut.of(Key.KeyV, {shift: true}),
        description: "Revert selected audio clips or regions (reverse playback)"
    }
})

export const TimelineAudioShortcuts = ShortcutDefinitions.copy(TimelineAudioShortcutsFactory)
