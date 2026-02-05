import css from "./PreferencesPage.sass?inline"
import { createElement, PageContext, PageFactory } from "@opendaw/lib-jsx"
import { StudioService } from "@/service/StudioService.ts"
import { BackButton } from "@/ui/pages/BackButton"
import { Files, Html, ShortcutDefinitions } from "@opendaw/lib-dom"
import { PreferencePanel } from "@/ui/PreferencePanel"
import { FilePickerAcceptTypes, StudioPreferences } from "@opendaw/studio-core"
import { StudioShortcutManager } from "@/service/StudioShortcutManager"
import { Notifier, Objects } from "@opendaw/lib-std"
import { ShortcutManagerView } from "@/ui/components/ShortcutManagerView"
import { Button } from "@/ui/components/Button"
import { Colors } from "@opendaw/studio-enums"
import { Promises } from "@opendaw/lib-runtime"
import { PreferencesPageLabels } from "@/ui/pages/PreferencesPageLabels"

const className = Html.adoptStyleSheet(css, "PreferencesPage")

export const PreferencesPage: PageFactory<StudioService> = ({ lifecycle, service }: PageContext<StudioService>) => {
    // this is for the shortcuts panel
    const updateNotifier = new Notifier<void>()
    const contexts: StudioShortcutManager.ShortcutsMap = {}
    Objects.entries(StudioShortcutManager.Contexts).forEach(([key, shortcuts]) =>
        contexts[key] = ShortcutDefinitions.copy(shortcuts.workingDefinition))
    return (
        <div className={className}>
            <BackButton />
            <h1>Preferences</h1>
            <div className="sections">
                <section>
                    <div className="header">
                        <h2>Studio UI</h2>
                        <span>(Changes are applied immediately)</span>
                    </div>
                    <PreferencePanel lifecycle={lifecycle}
                        preferences={StudioPreferences}
                        labels={PreferencesPageLabels.StudioSettingsLabels}
                        options={PreferencesPageLabels.StudioSettingsOptions} />
                </section>
                <section>
                    <div className="header">
                        <h2>Audio Engine</h2>
                        <span>(Changes are applied immediately)</span>
                    </div>
                    <PreferencePanel lifecycle={lifecycle}
                        preferences={service.engine.preferences}
                        labels={PreferencesPageLabels.EngineSettingsLabels}
                        options={PreferencesPageLabels.EngineSettingsOptions} />
                </section>
                <section>
                    <div className="shortcuts">
                        <h2>Shortcuts</h2>
                        <div className="buttons">
                            <Button lifecycle={lifecycle} onClick={() => {
                                Objects.entries(StudioShortcutManager.Contexts).forEach(([key, { workingDefinition }]) =>
                                    ShortcutDefinitions.copyInto(contexts[key], workingDefinition))
                                StudioShortcutManager.store()
                            }} appearance={{ color: Colors.cyan }}>APPLY</Button>
                            <Button lifecycle={lifecycle} onClick={() => {
                                Objects.entries(StudioShortcutManager.Contexts).forEach(([key, { factory }]) =>
                                    contexts[key] = ShortcutDefinitions.copy(factory))
                                updateNotifier.notify()
                            }} appearance={{ color: Colors.cream }}>FACTORY</Button>
                            <Button lifecycle={lifecycle} onClick={() => {
                                Objects.entries(StudioShortcutManager.Contexts).forEach(([key, { workingDefinition }]) =>
                                    contexts[key] = ShortcutDefinitions.copy(workingDefinition))
                                updateNotifier.notify()
                            }} appearance={{ color: Colors.cream }}>RESET</Button>
                            <Button lifecycle={lifecycle} onClick={async () => {
                                const { status, value: jsonString, error } = await Promises
                                    .tryCatch(Files.open({ types: [FilePickerAcceptTypes.JsonFileType] })
                                        .then(([file]) => file.text()))
                                if (status === "resolved") {
                                    StudioShortcutManager.fromJSONString(contexts, jsonString)
                                    updateNotifier.notify()
                                } else {
                                    console.warn(error)
                                }
                            }} appearance={{ color: Colors.green }}>LOAD</Button>
                            <Button lifecycle={lifecycle} onClick={() => StudioShortcutManager.toJSONString(contexts)
                                .ifSome(jsonString => Files.save(new TextEncoder().encode(jsonString).buffer,
                                    { suggestedName: "openDAW.shortcuts.json" }))}
                                appearance={{ color: Colors.green }}>SAVE</Button>
                        </div>
                    </div>
                    <ShortcutManagerView lifecycle={lifecycle}
                        contexts={contexts}
                        updateNotifier={updateNotifier} />
                </section>
            </div>
        </div>
    )
}