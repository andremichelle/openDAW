import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"
import {CommonShortcuts} from "@/ui/shortcuts/CommonShortcuts"

const shift = true
const ctrl = true

export const GlobalShortcutsFactory = ShortcutValidator.validate({
    "project-undo": {
        shortcut: Shortcut.of(Key.KeyZ, {ctrl}),
        description: "Undo last action"
    },
    "project-redo": {
        shortcut: Shortcut.of(Key.KeyZ, {ctrl, shift}),
        description: "Redo last action"
    },
    "project-open": {
        shortcut: Shortcut.of(Key.KeyO, {ctrl}),
        description: "Open project from local storage"
    },
    "project-save": {
        shortcut: Shortcut.of(Key.KeyS, {ctrl}),
        description: "Save project to local storage"
    },
    "project-save-as": {
        shortcut: Shortcut.of(Key.KeyS, {ctrl, shift}),
        description: "Save project as new file"
    },
    ...CommonShortcuts.Position,
    "toggle-playback": {
        shortcut: Shortcut.of(Key.Space),
        description: "Start or pause playback"
    },
    "stop-playback": {
        shortcut: Shortcut.of(Key.Period),
        description: "Stop playback"
    },
    "start-recording": {
        shortcut: Shortcut.of(Key.KeyR),
        description: "Start recording"
    },
    "restart-recording": {
        shortcut: Shortcut.of(Key.KeyR, {ctrl}),
        description: "Restart recording (deletes recordings and starts over)"
    },
    "start-recording-direct": {
        shortcut: Shortcut.of(Key.KeyR, {shift}),
        description: "Start reocrding without count-in"
    },
    "toggle-software-keyboard": {
        shortcut: Shortcut.of(Key.KeyK, {ctrl}),
        description: "Show or hide software keyboard"
    },
    "toggle-device-panel": {
        shortcut: Shortcut.of(Key.KeyD, {shift}),
        description: "Show or hide device panel"
    },
    "toggle-content-editor-panel": {
        shortcut: Shortcut.of(Key.KeyE, {shift}),
        description: "Show or hide content editor"
    },
    "toggle-browser-panel": {
        shortcut: Shortcut.of(Key.KeyB, {shift}),
        description: "Show or hide browser panel"
    },
    "toggle-tempo-track": {
        shortcut: Shortcut.of(Key.KeyT, {shift}),
        description: "Show or hide tempo track"
    },
    "toggle-markers-track": {
        shortcut: Shortcut.of(Key.KeyM, {shift}),
        description: "Show or hide markers track"
    },
    "toggle-clips": {
        shortcut: Shortcut.of(Key.KeyC, {shift}),
        description: "Show or hide clips"
    },
    "toggle-follow-cursor": {
        shortcut: Shortcut.of(Key.KeyF, {shift}),
        description: "Toggle follow playhead"
    },
    "toggle-metronome": {
        shortcut: Shortcut.of(Key.KeyM, {ctrl}),
        description: "Toggle metronome"
    },
    "toggle-loop": {
        shortcut: Shortcut.of(Key.KeyL, {shift}),
        description: "Toggle loop mode"
    },
    "copy-device": {
        shortcut: Shortcut.of(Key.KeyD, {ctrl}),
        description: "Duplicate selected device"
    },
    "workspace-next-screen": {
        shortcut: Shortcut.of(Key.Tab),
        description: "Switch to next screen"
    },
    "workspace-prev-screen": {
        shortcut: Shortcut.of(Key.Tab, {shift}),
        description: "Switch to previous screen"
    },
    "workspace-screen-dashboard": {
        shortcut: Shortcut.of(Key.Digit0, {shift}),
        description: "Go to dashboard"
    },
    "workspace-screen-default": {
        shortcut: Shortcut.of(Key.Digit1, {shift}),
        description: "Go to arrangement view"
    },
    "workspace-screen-mixer": {
        shortcut: Shortcut.of(Key.Digit2, {shift}),
        description: "Go to mixer view"
    },
    "workspace-screen-piano": {
        shortcut: Shortcut.of(Key.Digit3, {shift}),
        description: "Go to piano roll"
    },
    "workspace-screen-project": {
        shortcut: Shortcut.of(Key.Digit4, {shift}),
        description: "Go to project settings"
    },
    "workspace-screen-shadertoy": {
        shortcut: Shortcut.of(Key.Digit5, {shift}),
        description: "Go to shader visualizer"
    },
    "workspace-screen-meter": {
        shortcut: Shortcut.of(Key.Digit6, {shift}),
        description: "Go to meter view"
    },
    "show-preferences": {
        shortcut: Shortcut.of(Key.Comma, {ctrl}),
        description: "Open preferences"
    }
})

export const GlobalShortcuts = ShortcutDefinitions.copy(GlobalShortcutsFactory)