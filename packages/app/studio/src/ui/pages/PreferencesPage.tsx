import css from "./PreferencesPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {BackButton} from "@/ui/pages/BackButton"
import {Files, Html, ShortcutDefinitions} from "@opendaw/lib-dom"
import {NestedLabels, PreferencePanel} from "@/ui/PreferencePanel"
import {FilePickerAcceptTypes, FpsOptions, StudioPreferences, StudioSettings} from "@opendaw/studio-core"
import {EngineSettings} from "@opendaw/studio-adapters"
import {StudioShortcutManager} from "@/service/StudioShortcutManager"
import {Notifier, Objects} from "@opendaw/lib-std"
import {ShortcutManagerView} from "@/ui/components/ShortcutManagerView"
import {Button} from "@/ui/components/Button"
import {Colors} from "@opendaw/studio-enums"
import {Promises} from "@opendaw/lib-runtime"

const className = Html.adoptStyleSheet(css, "PreferencesPage")

const StudioSettingsLabels: NestedLabels<StudioSettings> = {
    "visibility": {
        label: "Visibility",
        fields: {
            "visible-help-hints": "Visible Help & Hints",
            "enable-history-buttons": "Show Undo/Redo buttons",
            "auto-open-clips": "Always open clip view",
            "scrollbar-padding": "Add scrollbar padding in browsers"
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
                    <div className="header">
                        <h2>Studio UI</h2>
                        <span>(Changes are applied immediately)</span>
                    </div>
                    <PreferencePanel lifecycle={lifecycle}
                                     preferences={StudioPreferences}
                                     labels={StudioSettingsLabels}
                                     options={StudioSettingsOptions}/>
                </section>
                <section>
                    <div className="header">
                        <h2>Audio Engine</h2>
                        <span>(Changes are applied immediately)</span>
                    </div>
                    <PreferencePanel lifecycle={lifecycle}
                                     preferences={service.engine.preferences}
                                     labels={EngineSettingsLabels}
                                     options={EngineSettingsOptions}/>
                </section>
                <section>
                    <div className="shortcuts">
                        <h2>Shortcuts</h2>
                        <div className="buttons">
                            <Button lifecycle={lifecycle} onClick={() => {
                                Objects.entries(StudioShortcutManager.Contexts).forEach(([key, {workingDefinition}]) =>
                                    ShortcutDefinitions.copyInto(contexts[key], workingDefinition))
                                StudioShortcutManager.store()
                            }} appearance={{color: Colors.purple}}>APPLY</Button>
                            <Button lifecycle={lifecycle} onClick={() => {
                                Objects.entries(StudioShortcutManager.Contexts).forEach(([key, {factory}]) =>
                                    contexts[key] = ShortcutDefinitions.copy(factory))
                                updateNotifier.notify()
                            }} appearance={{color: Colors.cream}}>FACTORY</Button>
                            <Button lifecycle={lifecycle} onClick={() => {
                                Objects.entries(StudioShortcutManager.Contexts).forEach(([key, {workingDefinition}]) =>
                                    contexts[key] = ShortcutDefinitions.copy(workingDefinition))
                                updateNotifier.notify()
                            }} appearance={{color: Colors.cream}}>RESET</Button>
                            <Button lifecycle={lifecycle} onClick={async () => {
                                const {status, value: jsonString, error} = await Promises
                                    .tryCatch(Files.open({types: [FilePickerAcceptTypes.JsonFileType]})
                                        .then(([file]) => file.text()))
                                if (status === "resolved") {
                                    StudioShortcutManager.fromJSONString(contexts, jsonString)
                                    updateNotifier.notify()
                                } else {
                                    console.warn(error)
                                }
                            }} appearance={{color: Colors.green}}>LOAD</Button>
                            <Button lifecycle={lifecycle} onClick={() => StudioShortcutManager.toJSONString(contexts)
                                .ifSome(jsonString => Files.save(new TextEncoder().encode(jsonString).buffer,
                                    {suggestedName: "openDAW.shortcuts.json"}))}
                                    appearance={{color: Colors.green}}>SAVE</Button>
                        </div>
                    </div>
                    <ShortcutManagerView lifecycle={lifecycle}
                                         contexts={contexts}
                                         updateNotifier={updateNotifier}/>
                </section>
            </div>
        </div>
    )
}