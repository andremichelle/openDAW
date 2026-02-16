import {
    Arrays,
    isDefined,
    isNull,
    JSONValue,
    Objects,
    Option,
    Subscription,
    Terminable,
    tryCatch
} from "@opendaw/lib-std"
import {ShortcutDefinitions, ShortcutManager} from "@opendaw/lib-dom"
import {GlobalShortcuts, GlobalShortcutsFactory} from "@/ui/shortcuts/GlobalShortcuts"
import {StudioService} from "@/service/StudioService"
import {DefaultWorkspace} from "@/ui/workspace/Default"
import {PanelType} from "@/ui/workspace/PanelType"
import {Workspace} from "@/ui/workspace/Workspace"
import {DeviceHost, Devices, TransferAudioUnits} from "@opendaw/studio-adapters"
import {ContentEditorShortcuts, ContentEditorShortcutsFactory} from "@/ui/shortcuts/ContentEditorShortcuts"
import {PianoPanelShortcuts, PianoPanelShortcutsFactory} from "@/ui/shortcuts/PianoPanelShortcuts"
import {RegionsShortcuts, RegionsShortcutsFactory} from "@/ui/shortcuts/RegionsShortcuts"
import {NoteEditorShortcuts, NoteEditorShortcutsFactory} from "@/ui/shortcuts/NoteEditorShortcuts"
import {SoftwareMIDIShortcuts, SoftwareMIDIShortcutsFactory} from "@/ui/shortcuts/SoftwareMIDIShortcuts"
import {RouteLocation} from "@opendaw/lib-jsx"

export namespace StudioShortcutManager {
    const localStorageKey = "shortcuts"

    export type ShortcutsMap = Record<string, ShortcutDefinitions>

    export const Contexts = {
        "global": {factory: GlobalShortcutsFactory, workingDefinition: GlobalShortcuts},
        "regions": {factory: RegionsShortcutsFactory, workingDefinition: RegionsShortcuts},
        "note-editor": {factory: NoteEditorShortcutsFactory, workingDefinition: NoteEditorShortcuts},
        "content-editor": {factory: ContentEditorShortcutsFactory, workingDefinition: ContentEditorShortcuts},
        "software-midi": {factory: SoftwareMIDIShortcutsFactory, workingDefinition: SoftwareMIDIShortcuts},
        "piano-panel": {factory: PianoPanelShortcutsFactory, workingDefinition: PianoPanelShortcuts}
    } as const satisfies Record<string, { factory: ShortcutDefinitions, workingDefinition: ShortcutDefinitions }>

    export const toJSONString = (source: ShortcutsMap): Option<string> => {
        const contexts: JSONValue = Objects.entries(source).reduce((record, [key, definition]) => {
            record[key] = ShortcutDefinitions.toJSON(definition)
            return record
        }, {} as Record<string, JSONValue>)
        return Option.tryCatch(() => JSON.stringify(contexts))
    }

    export const fromJSONString = (target: ShortcutsMap, source: string): void => {
        const {status, value: stored, error} = tryCatch(() => JSON.parse(source))
        if (status === "success") {
            Objects.entries(target).forEach(([key, definition]) => ShortcutDefinitions.fromJSON(definition, stored[key]))
        } else {
            console.warn(error)
        }
    }

    export const store = (): void => {
        const shortcuts: ShortcutsMap = {}
        Objects.entries(Contexts).forEach(([key, {workingDefinition}]) => shortcuts[key] = workingDefinition)
        toJSONString(shortcuts).ifSome(jsonString => localStorage.setItem(localStorageKey, jsonString))
    }

    export const install = (service: StudioService): Subscription => {
        const {global: gc} = ShortcutManager.get()
        const {engine} = service
        const {
            engine: {preferences: {settings: {metronome}}, isPlaying, isRecording, isCountingIn, position},
            panelLayout,
            timeline: {
                clips: {visible: clipsVisibility},
                followCursor,
                primaryVisibility: {markers, tempo, signature},
                snapping
            }
        } = service
        const gs = GlobalShortcuts
        const storedShortcuts = localStorage.getItem(localStorageKey)
        if (isDefined(storedShortcuts)) {
            const {status, value: stored, error} = tryCatch(() => JSON.parse(storedShortcuts))
            if (status === "success") {
                Objects.entries(Contexts).forEach(([name, {workingDefinition}]) =>
                    ShortcutDefinitions.fromJSON(workingDefinition, stored[name]))
                console.debug("Custom shortcuts loaded.")
            } else {
                console.warn(error)
            }
        }
        return Terminable.many(
            gc.register(gs["project-undo"].shortcut, () => service.runIfProject(project => project.editing.undo()), {allowRepeat: true}),
            gc.register(gs["project-redo"].shortcut, () => service.runIfProject(project => project.editing.redo()), {allowRepeat: true}),
            gc.register(gs["project-open"].shortcut, async () => await service.browseLocalProjects()),
            gc.register(gs["project-save"].shortcut, async () => await service.projectProfileService.save(), {activeInTextField: true}),
            gc.register(gs["project-save-as"].shortcut, async () => await service.projectProfileService.saveAs(), {activeInTextField: true}),
            gc.register(gs["position-increment"].shortcut, () => {
                if (!isPlaying.getValue()) {
                    const pos = position.getValue()
                    engine.setPosition(snapping.floor(pos) + snapping.value(pos))
                }
            }, {allowRepeat: true}),
            gc.register(gs["position-decrement"].shortcut, () => {
                if (!engine.isPlaying.getValue()) {
                    const pos = position.getValue()
                    engine.setPosition(Math.max(0, snapping.ceil(pos) - snapping.value(pos)))
                }
            }, {allowRepeat: true}),
            gc.register(gs["toggle-playback"].shortcut, () => {
                const {engine} = service
                const isPlaying = engine.isPlaying.getValue()
                if (isPlaying) {engine.stop()} else {engine.play()}
            }),
            gc.register(gs["stop-playback"].shortcut, () => engine.stop(true)),
            gc.register(gs["start-recording"].shortcut, () => {
                if (isCountingIn.getValue()) {
                    engine.stop()
                } else if (isRecording.getValue()) {
                    service.runIfProject(project => project.stopRecording())
                } else {
                    service.runIfProject(project => project.startRecording(true))
                    document.querySelector<HTMLElement>("[data-scope=\"regions\"]")?.focus()
                }
            }),
            gc.register(gs["restart-recording"].shortcut, () => service.runIfProject(project => project.restartRecording())),
            gc.register(gs["start-recording-direct"].shortcut, () => {
                if (isCountingIn.getValue()) {
                    engine.stop()
                } else if (isRecording.getValue()) {
                    service.runIfProject(project => project.stopRecording())
                } else {
                    service.runIfProject(project => project.startRecording(false))
                    document.querySelector<HTMLElement>("[data-scope=\"regions\"]")?.focus()
                }
            }),
            gc.register(gs["toggle-software-keyboard"].shortcut, () => service.toggleSoftwareKeyboard()),
            gc.register(gs["toggle-device-panel"].shortcut, () => panelLayout.getByType(PanelType.DevicePanel).toggleMinimize()),
            gc.register(gs["toggle-content-editor-panel"].shortcut, () => panelLayout.getByType(PanelType.ContentEditor).toggleMinimize()),
            gc.register(gs["toggle-browser-panel"].shortcut, () => panelLayout.getByType(PanelType.BrowserPanel).toggleMinimize()),
            gc.register(gs["toggle-tempo-track"].shortcut, () => tempo.setValue(!tempo.getValue())),
            gc.register(gs["toggle-markers-track"].shortcut, () => markers.setValue(!markers.getValue())),
            gc.register(gs["toggle-signature-track"].shortcut, () => signature.setValue(!signature.getValue())),
            gc.register(gs["toggle-clips"].shortcut, () => clipsVisibility.setValue(!clipsVisibility.getValue())),
            gc.register(gs["toggle-follow-cursor"].shortcut, () => followCursor.setValue(!followCursor.getValue())),
            gc.register(gs["toggle-metronome"].shortcut, () => metronome.enabled = !metronome.enabled),
            gc.register(gs["toggle-loop"].shortcut, () =>
                service.runIfProject(({editing, timelineBox: {loopArea: {enabled}}}) =>
                    editing.modify(() => enabled.setValue(!enabled.getValue())))),
            gc.register(gs["copy-device"].shortcut, () => service.runIfProject(
                ({editing, boxAdapters, userEditingManager, skeleton}) => userEditingManager.audioUnit.get()
                    .ifSome(({box}) => {
                        const deviceHost: DeviceHost = boxAdapters.adapterFor(box, Devices.isHost)
                        const copies = editing.modify(() => TransferAudioUnits
                            .transfer([deviceHost.audioUnitBoxAdapter().box], skeleton), false).unwrap()
                        userEditingManager.audioUnit.edit(copies[0].editing)
                    }))),
            gc.register(gs["workspace-next-screen"].shortcut, () => {
                    if (!service.hasProfile) {return}
                    const keys: Array<Workspace.ScreenKeys> = Object.entries(DefaultWorkspace)
                        .map(([key]) => key as Workspace.ScreenKeys)
                        .filter(key => key !== "dashboard")
                    const screen = service.layout.screen
                    const current = screen.getValue()
                    if (isNull(current) || !keys.includes(current)) {return}
                    screen.setValue(Arrays.getNext(keys, current))
                }
            ),
            gc.register(gs["workspace-prev-screen"].shortcut, () => {
                    if (!service.hasProfile) {return}
                    const keys: Array<Workspace.ScreenKeys> = Objects.entries(DefaultWorkspace)
                        .map(([key]) => key as Workspace.ScreenKeys)
                        .filter(key => key !== "dashboard")
                    const screen = service.layout.screen
                    const current = screen.getValue()
                    if (isNull(current) || !keys.includes(current)) {return}
                    screen.setValue(Arrays.getPrev(keys, current))
                }
            ),
            gc.register(gs["workspace-screen-dashboard"].shortcut, async () => await service.closeProject()),
            gc.register(gs["workspace-screen-default"].shortcut, () => service.runIfProject(() => service.switchScreen("default"))),
            gc.register(gs["workspace-screen-mixer"].shortcut, () => service.runIfProject(() => service.switchScreen("mixer"))),
            gc.register(gs["workspace-screen-piano"].shortcut, () => service.runIfProject(() => service.switchScreen("piano"))),
            gc.register(gs["workspace-screen-project"].shortcut, () => service.runIfProject(() => service.switchScreen("project"))),
            gc.register(gs["workspace-screen-meter"].shortcut, () => service.runIfProject(() => service.switchScreen("meter"))),
            gc.register(gs["workspace-screen-shadertoy"].shortcut, () => service.runIfProject(() => service.switchScreen("shadertoy"))),
            gc.register(gs["show-preferences"].shortcut, () => RouteLocation.get().navigateTo("/preferences"))
        )
    }
}