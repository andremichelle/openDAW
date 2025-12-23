import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"

const shift = true
const ctrl = true

export const GlobalShortcutsFactory = ShortcutValidator.validate({
    "project-undo": {
        keys: Shortcut.of(Key.KeyZ, {ctrl}),
        description: "Undo last action"
    },
    "project-redo": {
        keys: Shortcut.of(Key.KeyZ, {ctrl, shift}),
        description: "Redo last action"
    },
    "project-open": {
        keys: Shortcut.of(Key.KeyO, {ctrl}),
        description: "Open project from local storage"
    },
    "project-save": {
        keys: Shortcut.of(Key.KeyS, {ctrl}),
        description: "Save project to local storage"
    },
    "project-save-as": {
        keys: Shortcut.of(Key.KeyS, {ctrl, shift}),
        description: "Save project as new file"
    },
    "toggle-playback": {
        keys: Shortcut.of(Key.Space),
        description: "Start or pause playback"
    },
    "toggle-software-keyboard": {
        keys: Shortcut.of(Key.KeyK, {ctrl}),
        description: "Show or hide software keyboard"
    },
    "toggle-device-panel": {
        keys: Shortcut.of(Key.KeyD, {shift}),
        description: "Show or hide device panel"
    },
    "toggle-content-editor-panel": {
        keys: Shortcut.of(Key.KeyE, {shift}),
        description: "Show or hide content editor"
    },
    "toggle-browser-panel": {
        keys: Shortcut.of(Key.KeyB, {shift}),
        description: "Show or hide browser panel"
    },
    "toggle-tempo-track": {
        keys: Shortcut.of(Key.KeyT, {shift}),
        description: "Show or hide tempo track"
    },
    "toggle-markers-track": {
        keys: Shortcut.of(Key.KeyM, {shift}),
        description: "Show or hide markers track"
    },
    "toggle-clips": {
        keys: Shortcut.of(Key.KeyC, {shift}),
        description: "Show or hide clips"
    },
    "toggle-follow-cursor": {
        keys: Shortcut.of(Key.KeyF, {shift}),
        description: "Toggle follow playhead"
    },
    "toggle-metronome": {
        keys: Shortcut.of(Key.KeyM, {ctrl}),
        description: "Enable or disable metronome"
    },
    "copy-device": {
        keys: Shortcut.of(Key.KeyD, {ctrl}),
        description: "Duplicate selected device"
    },
    "workspace-next-screen": {
        keys: Shortcut.of(Key.Tab),
        description: "Switch to next screen"
    },
    "workspace-prev-screen": {
        keys: Shortcut.of(Key.Tab, {shift}),
        description: "Switch to previous screen"
    },
    "workspace-screen-dashboard": {
        keys: Shortcut.of(Key.Digit0, {shift}),
        description: "Go to dashboard"
    },
    "workspace-screen-default": {
        keys: Shortcut.of(Key.Digit1, {shift}),
        description: "Go to arrangement view"
    },
    "workspace-screen-mixer": {
        keys: Shortcut.of(Key.Digit2, {shift}),
        description: "Go to mixer view"
    },
    "workspace-screen-piano": {
        keys: Shortcut.of(Key.Digit3, {shift}),
        description: "Go to piano roll"
    },
    "workspace-screen-project": {
        keys: Shortcut.of(Key.Digit4, {shift}),
        description: "Go to project settings"
    },
    "workspace-screen-shadertoy": {
        keys: Shortcut.of(Key.Digit5, {shift}),
        description: "Go to shader visualizer"
    },
    "workspace-screen-meter": {
        keys: Shortcut.of(Key.Digit6, {shift}),
        description: "Go to meter view"
    },
    "show-preferences": {
        keys: Shortcut.of(Key.Comma, {ctrl}),
        description: "Open preferences"
    }
})

export const GlobalShortcuts = ShortcutDefinitions.copy(GlobalShortcutsFactory)