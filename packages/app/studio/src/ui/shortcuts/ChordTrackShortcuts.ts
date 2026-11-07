import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"
import {CommonShortcuts} from "@/ui/shortcuts/CommonShortcuts"

const ctrl = true

export const ChordTrackShortcutsFactory = ShortcutValidator.validate({
    ...CommonShortcuts.Selection,
    "duplicate-chords": {
        shortcut: Shortcut.of(Key.KeyD, {ctrl}),
        description: "Duplicate chords"
    },
    "degree-1": {shortcut: Shortcut.of(Key.Digit1), description: "Set chords to step 1"},
    "degree-2": {shortcut: Shortcut.of(Key.Digit2), description: "Set chords to step 2"},
    "degree-3": {shortcut: Shortcut.of(Key.Digit3), description: "Set chords to step 3"},
    "degree-4": {shortcut: Shortcut.of(Key.Digit4), description: "Set chords to step 4"},
    "degree-5": {shortcut: Shortcut.of(Key.Digit5), description: "Set chords to step 5"},
    "degree-6": {shortcut: Shortcut.of(Key.Digit6), description: "Set chords to step 6"},
    "degree-7": {shortcut: Shortcut.of(Key.Digit7), description: "Set chords to step 7"}
})

export const ChordTrackShortcuts = ShortcutDefinitions.copy(ChordTrackShortcutsFactory)

export const DegreeShortcuts = [
    ChordTrackShortcuts["degree-1"],
    ChordTrackShortcuts["degree-2"],
    ChordTrackShortcuts["degree-3"],
    ChordTrackShortcuts["degree-4"],
    ChordTrackShortcuts["degree-5"],
    ChordTrackShortcuts["degree-6"],
    ChordTrackShortcuts["degree-7"]
] as const
