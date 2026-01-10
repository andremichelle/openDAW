import {NestedLabels} from "@/ui/PreferencePanel"
import {FpsOptions, StudioSettings} from "@opendaw/studio-core"
import {EngineSettings} from "@opendaw/studio-adapters"

export namespace PreferencesPageLabels {
    export const StudioSettingsLabels: NestedLabels<StudioSettings> = {
        "visibility": {
            label: "Visibility",
            fields: {
                "visible-help-hints": "Visible Help & Hints",
                "enable-history-buttons": "Show Undo/Redo buttons",
                "auto-open-clips": "Always open clip view",
                "scrollbar-padding": "Add scrollbar padding"
            }
        },
        "time-display": {
            label: "Time Display",
            fields: {
                musical: "Show musical time",
                absolute: "Show absolute time",
                details: "Show details",
                fps: "Frame rate"
            }
        },
        "engine": {
            label: "Engine",
            fields: {
                "note-audition-while-editing": "Note audition while editing",
                "auto-create-output-compressor": "Automatically add compressor to main output"
            }
        },
        "pointer": {
            label: "Pointer (Mouse/Touch)",
            fields: {
                "dragging-use-pointer-lock": "Use Pointer Lock at window edges [Chrome only]",
                "modifying-controls-wheel": "Modify controls with mouse wheel",
                "normalize-mouse-wheel": "Normalize mouse wheel speed"
            }
        },
        "debug": {
            label: "Debug",
            fields: {
                "footer-show-fps-meter": "Show FPS meter",
                "footer-show-samples-memory": "Show samples in memory",
                "footer-show-build-infos": "Show Build Information",
                "enable-beta-features": "Enable Experimental Features",
                "enable-debug-menu": "Enable Debug Menu"
            }
        }
    }

    export const StudioSettingsOptions = {
        "time-display": {
            fps: FpsOptions.map(value => ({value, label: `${value}`}))
        }
    }

    export const EngineSettingsLabels: NestedLabels<EngineSettings> = {
        metronome: {
            label: "Metronome",
            fields: {
                enabled: "Enabled",
                beatSubDivision: "Beat subdivision",
                gain: "Volume (dB)"
            }
        },
        playback: {
            label: "Playback",
            fields: {
                timestampEnabled: "Start playback from last start position",
                pauseOnLoopDisabled: "Pause on loop end if loop is disabled",
                truncateNotesAtRegionEnd: "Stop notes at region end"
            }
        },
        recording: {
            label: "Recording",
            fields: {
                countInBars: "Count-in bars",
                allowTakes: "Allow takes",
                olderTakeAction: "Older take action",
                olderTakeScope: "Older take scope"
            }
        }
    }

    export const EngineSettingsOptions = {
        metronome: {
            beatSubDivision: EngineSettings.BeatSubDivisionOptions.map(value => ({value, label: `1/${value}`}))
        },
        recording: {
            countInBars: EngineSettings.RecordingCountInBars.map(value => ({value, label: `${value}`})),
            olderTakeAction: EngineSettings.OlderTakeActionOptions.map(value => ({
                value,
                label: value === "disable-track" ? "Disable track" : "Mute region"
            })),
            olderTakeScope: EngineSettings.OlderTakeScopeOptions.map(value => ({
                value,
                label: value === "all" ? "All takes" : "Previous only"
            }))
        }
    }
}