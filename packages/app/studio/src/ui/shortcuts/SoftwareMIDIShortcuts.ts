import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"

export const SoftwareMIDIShortcutsFactory = ShortcutValidator.validate({
    "increment-octave": {
        shortcut: Shortcut.of(Key.ArrowUp),
        description: "Increase octave"
    },
    "decrement-octave": {
        shortcut: Shortcut.of(Key.ArrowDown),
        description: "Decrease octave"
    },
    "play-note-0": {
        shortcut: Shortcut.of(Key.KeyA),
        description: "Play C"
    },
    "play-note-1": {
        shortcut: Shortcut.of(Key.KeyW),
        description: "Play C#"
    },
    "play-note-2": {
        shortcut: Shortcut.of(Key.KeyS),
        description: "Play D"
    },
    "play-note-3": {
        shortcut: Shortcut.of(Key.KeyE),
        description: "Play D#"
    },
    "play-note-4": {
        shortcut: Shortcut.of(Key.KeyD),
        description: "Play E"
    },
    "play-note-5": {
        shortcut: Shortcut.of(Key.KeyF),
        description: "Play F"
    },
    "play-note-6": {
        shortcut: Shortcut.of(Key.KeyT),
        description: "Play F#"
    },
    "play-note-7": {
        shortcut: Shortcut.of(Key.KeyG),
        description: "Play G"
    },
    "play-note-8": {
        shortcut: Shortcut.of(Key.KeyY),
        description: "Play G#"
    },
    "play-note-9": {
        shortcut: Shortcut.of(Key.KeyH),
        description: "Play A"
    },
    "play-note-10": {
        shortcut: Shortcut.of(Key.KeyU),
        description: "Play A#"
    },
    "play-note-11": {
        shortcut: Shortcut.of(Key.KeyJ),
        description: "Play B"
    },
    "play-note-12": {
        shortcut: Shortcut.of(Key.KeyK),
        description: "Play C (next octave)"
    },
    "play-note-13": {
        shortcut: Shortcut.of(Key.KeyO),
        description: "Play C# (next octave)"
    },
    "play-note-14": {
        shortcut: Shortcut.of(Key.KeyL),
        description: "Play D (next octave)"
    },
    "play-note-15": {
        shortcut: Shortcut.of(Key.KeyP),
        description: "Play D# (next octave)"
    },
    "play-note-16": {
        shortcut: Shortcut.of(Key.Semicolon),
        description: "Play E (next octave)"
    },
    "play-note-17": {
        shortcut: Shortcut.of(Key.Quote),
        description: "Play F (next octave)"
    }
})

export const SoftwareMIDIShortcuts = ShortcutDefinitions.copy(SoftwareMIDIShortcutsFactory)

export const NoteShortcuts = [
    SoftwareMIDIShortcuts["play-note-0"],
    SoftwareMIDIShortcuts["play-note-1"],
    SoftwareMIDIShortcuts["play-note-2"],
    SoftwareMIDIShortcuts["play-note-3"],
    SoftwareMIDIShortcuts["play-note-4"],
    SoftwareMIDIShortcuts["play-note-5"],
    SoftwareMIDIShortcuts["play-note-6"],
    SoftwareMIDIShortcuts["play-note-7"],
    SoftwareMIDIShortcuts["play-note-8"],
    SoftwareMIDIShortcuts["play-note-9"],
    SoftwareMIDIShortcuts["play-note-10"],
    SoftwareMIDIShortcuts["play-note-11"],
    SoftwareMIDIShortcuts["play-note-12"],
    SoftwareMIDIShortcuts["play-note-13"],
    SoftwareMIDIShortcuts["play-note-14"],
    SoftwareMIDIShortcuts["play-note-15"],
    SoftwareMIDIShortcuts["play-note-16"],
    SoftwareMIDIShortcuts["play-note-17"]
] as const
