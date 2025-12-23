import {Key, ShortcutKeys} from "@opendaw/lib-dom"
import {ShortcutValidator} from "@/shortcuts/ShortcutValidator"
import {ShortcutDefinitions} from "@/shortcuts/ShortcutDefinitions"

const shift = true
const ctrl = true

export const GlobalShortcutsFactory = ShortcutValidator.validate({
    "project-undo": {
        keys: ShortcutKeys.of(Key.KeyZ, {ctrl}),
        description: "Undo last action"
    },
    "project-redo": {
        keys: ShortcutKeys.of(Key.KeyZ, {ctrl, shift}),
        description: "Redo last action"
    },
    "project-open": {
        keys: ShortcutKeys.of(Key.KeyO, {ctrl}),
        description: "Open project from local storage"
    },
    "project-save": {
        keys: ShortcutKeys.of(Key.KeyS, {ctrl}),
        description: "Save project to local storage"
    },
    "project-save-as": {
        keys: ShortcutKeys.of(Key.KeyS, {ctrl, shift}),
        description: "Save project as new file"
    },
    "toggle-playback": {
        keys: ShortcutKeys.of(Key.Space),
        description: "Start or pause playback"
    },
    "toggle-software-keyboard": {
        keys: ShortcutKeys.of(Key.KeyK, {ctrl}),
        description: "Show or hide software keyboard"
    },
    "toggle-device-panel": {
        keys: ShortcutKeys.of(Key.KeyD, {shift}),
        description: "Show or hide device panel"
    },
    "toggle-content-editor-panel": {
        keys: ShortcutKeys.of(Key.KeyE, {shift}),
        description: "Show or hide content editor"
    },
    "toggle-browser-panel": {
        keys: ShortcutKeys.of(Key.KeyB, {shift}),
        description: "Show or hide browser panel"
    },
    "toggle-tempo-track": {
        keys: ShortcutKeys.of(Key.KeyT, {shift}),
        description: "Show or hide tempo track"
    },
    "toggle-markers-track": {
        keys: ShortcutKeys.of(Key.KeyM, {shift}),
        description: "Show or hide markers track"
    },
    "toggle-clips": {
        keys: ShortcutKeys.of(Key.KeyC, {shift}),
        description: "Show or hide clips"
    },
    "toggle-follow-cursor": {
        keys: ShortcutKeys.of(Key.KeyF, {shift}),
        description: "Toggle follow playhead"
    },
    "toggle-metronome": {
        keys: ShortcutKeys.of(Key.KeyM, {ctrl}),
        description: "Enable or disable metronome"
    },
    "copy-device": {
        keys: ShortcutKeys.of(Key.KeyD, {ctrl}),
        description: "Duplicate selected device"
    },
    "workspace-next-screen": {
        keys: ShortcutKeys.of(Key.Tab),
        description: "Switch to next screen"
    },
    "workspace-prev-screen": {
        keys: ShortcutKeys.of(Key.Tab, {shift}),
        description: "Switch to previous screen"
    },
    "workspace-screen-dashboard": {
        keys: ShortcutKeys.of(Key.Digit0, {shift}),
        description: "Go to dashboard"
    },
    "workspace-screen-default": {
        keys: ShortcutKeys.of(Key.Digit1, {shift}),
        description: "Go to arrangement view"
    },
    "workspace-screen-mixer": {
        keys: ShortcutKeys.of(Key.Digit2, {shift}),
        description: "Go to mixer view"
    },
    "workspace-screen-piano": {
        keys: ShortcutKeys.of(Key.Digit3, {shift}),
        description: "Go to piano roll"
    },
    "workspace-screen-project": {
        keys: ShortcutKeys.of(Key.Digit4, {shift}),
        description: "Go to project settings"
    },
    "workspace-screen-shadertoy": {
        keys: ShortcutKeys.of(Key.Digit5, {shift}),
        description: "Go to shader visualizer"
    },
    "workspace-screen-meter": {
        keys: ShortcutKeys.of(Key.Digit6, {shift}),
        description: "Go to meter view"
    },
    "show-preferences": {
        keys: ShortcutKeys.of(Key.Comma, {ctrl}),
        description: "Open preferences"
    }
})

export const GlobalShortcuts = ShortcutDefinitions.copy(GlobalShortcutsFactory)