import css from "./PreferencesPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {BackButton} from "@/ui/pages/BackButton"
import {Html, ShortcutDefinitions} from "@opendaw/lib-dom"
import {NestedLabels, PreferencePanel} from "@/ui/PreferencePanel"
import {FpsOptions, StudioPreferences, StudioSettings} from "@opendaw/studio-core"
import {EngineSettings} from "@opendaw/studio-adapters"
import {StudioShortcutManager} from "@/service/StudioShortcutManager"
import {Notifier, Objects} from "@opendaw/lib-std"
import {ShortcutManagerView} from "@/ui/components/ShortcutManagerView"

const className = Html.adoptStyleSheet(css, "PreferencesPage")

const StudioSettingsLabels: NestedLabels<StudioSettings> = {
    "visible-help-hints": "Visible Help & Hints",
    "enable-history-buttons": "Show Undo/Redo buttons",
    "note-audition-while-editing": "Note audition while editing",
    "auto-open-clips": "Always open clip view",
    "auto-create-output-compressor": "Automatically add compressor to main output",
    "dragging-use-pointer-lock": "Use Pointer Lock at window edges [Chrome only]",
    "modifying-controls-wheel": "Modify controls with mouse wheel",
    "normalize-mouse-wheel": "Normalize mouse wheel speed",
    "time-display": {
        label: "Time Display",
        fields: {
            musical: "Show musical time",
            absolute: "Show absolute time",
            details: "Show details",
            fps: "Frame rate"
        }
    },
    "footer-show-fps-meter": "Show FPS meter",
    "footer-show-build-infos": "Show Build Information",
    "footer-show-samples-memory": "Show samples in memory",
    "enable-beta-features": "Enable Experimental Features"
}

const StudioSettingsOptions = {
    "time-display": {
        fps: FpsOptions.map(value => ({value, label: `${value}`}))
    }
}

const EngineSettingsLabels: NestedLabels<EngineSettings> = {
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

const EngineSettingsOptions = {
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

export const PreferencesPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const updateNotifier = new Notifier<void>()
    const contexts: StudioShortcutManager.ShortcutsMap = {}
    Objects.entries(StudioShortcutManager.Contexts).forEach(([key, shortcuts]) =>
        contexts[key] = ShortcutDefinitions.copy(shortcuts.workingDefinition))
    return (
        <div className={className}>
            <BackButton/>
            <h1>Preferences</h1>
            <div className="sections">
                <section>
                    <h2>Studio</h2>
                    <PreferencePanel lifecycle={lifecycle}
                                     preferences={StudioPreferences}
                                     labels={StudioSettingsLabels}
                                     options={StudioSettingsOptions}/>
                </section>
                <section>
                    <h2>Engine</h2>
                    <PreferencePanel lifecycle={lifecycle}
                                     preferences={service.engine.preferences}
                                     labels={EngineSettingsLabels}
                                     options={EngineSettingsOptions}/>
                </section>
                <section>
                    <h2>Shortcuts</h2>
                    <ShortcutManagerView lifecycle={lifecycle}
                                         contexts={contexts}
                                         updateNotifier={updateNotifier}/>
                </section>
            </div>
        </div>
    )
}
