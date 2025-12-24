import {
    Arrays,
    asInstanceOf,
    isDefined,
    isNull,
    JSONValue,
    Objects,
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
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ProjectUtils} from "@opendaw/studio-adapters"
import {StudioDialogs} from "@/service/StudioDialogs"
import {ContentEditorShortcuts, ContentEditorShortcutsFactory} from "@/ui/shortcuts/ContentEditorShortcuts"
import {PianoPanelShortcuts, PianoPanelShortcutsFactory} from "@/ui/shortcuts/PianoPanelShortcuts"
import {RegionsShortcuts, RegionsShortcutsFactory} from "@/ui/shortcuts/RegionsShortcuts"
import {NoteEditorShortcuts, NoteEditorShortcutsFactory} from "@/ui/shortcuts/NoteEditorShortcuts"

export namespace StudioShortcutManager {
    const localStorageKey = "shortcuts"

    export const Contexts = {
        "global": {factory: GlobalShortcutsFactory, user: GlobalShortcuts},
        "regions": {factory: RegionsShortcutsFactory, user: RegionsShortcuts},
        "note-editor": {factory: NoteEditorShortcutsFactory, user: NoteEditorShortcuts},
        "content-editor": {factory: ContentEditorShortcutsFactory, user: ContentEditorShortcuts},
        "piano-panel": {factory: PianoPanelShortcutsFactory, user: PianoPanelShortcuts}
    } as const satisfies Record<string, { factory: ShortcutDefinitions, user: ShortcutDefinitions }>

    export const reset = (): void => {
        Object.values(Contexts)
            .forEach(definitions => Object.entries(definitions.factory)
                .forEach(([key, {shortcut}]) =>
                    (definitions.user as ShortcutDefinitions)[key].shortcut.overrideWith(shortcut)))
    }

    export const store = (): void => {
        try {
            const contexts: JSONValue = Objects.entries(Contexts).reduce((record, [key, {user}]) => {
                record[key] = ShortcutDefinitions.toJSON(user)
                return record
            }, {} as Record<keyof typeof Contexts, JSONValue>)
            localStorage.setItem(localStorageKey, JSON.stringify(contexts))
            console.debug("Shortcuts saved.")
        } catch (reason) {
            console.warn(reason)
        }
    }

    export const install = (service: StudioService): Subscription => {
        const {global: gc} = ShortcutManager.get()
        const {engine} = service
        const {
            engine: {metronomeEnabled, isPlaying, position},
            panelLayout,
            timeline: {clips: {visible: clipsVisibility}, followCursor, primaryVisibility: {markers, tempo}, snapping}
        } = service
        const gs = GlobalShortcuts
        const storedShortcuts = localStorage.getItem(localStorageKey)
        if (isDefined(storedShortcuts)) {
            const {status, value: stored, error} = tryCatch(() => JSON.parse(storedShortcuts))
            if (status === "success") {
                Objects.entries(Contexts).forEach(([name, {user}]) => ShortcutDefinitions.fromJSON(user, stored[name]))
                console.debug("Custom shortcuts loaded.")
            } else {
                console.warn(error)
            }
        }
        return Terminable.many(
            gc.register(gs["project-undo"].shortcut, () => service.runIfProject(project => project.editing.undo())),
            gc.register(gs["project-redo"].shortcut, () => service.runIfProject(project => project.editing.redo())),
            gc.register(gs["project-open"].shortcut, async () => await service.browseLocalProjects()),
            gc.register(gs["project-save"].shortcut, async () => await service.projectProfileService.save(), {activeInTextField: true}),
            gc.register(gs["project-save-as"].shortcut, async () => await service.projectProfileService.saveAs(), {activeInTextField: true}),
            gc.register(gs["position-increment"].shortcut, () => {
                if (!isPlaying.getValue()) {
                    engine.setPosition(snapping.floor(position.getValue()) + snapping.value)
                }
            }, {allowRepeat: true}),
            gc.register(gs["position-decrement"].shortcut, () => {
                if (!engine.isPlaying.getValue()) {
                    engine.setPosition(Math.max(0,
                        snapping.ceil(position.getValue()) - snapping.value))
                }
            }, {allowRepeat: true}),
            gc.register(gs["toggle-playback"].shortcut, () => {
                const {engine} = service
                const isPlaying = engine.isPlaying.getValue()
                if (isPlaying) {engine.stop()} else {engine.play()}
            }),
            gc.register(gs["toggle-software-keyboard"].shortcut, () => service.toggleSoftwareKeyboard()),
            gc.register(gs["toggle-device-panel"].shortcut, () => panelLayout.getByType(PanelType.DevicePanel).toggleMinimize()),
            gc.register(gs["toggle-content-editor-panel"].shortcut, () => panelLayout.getByType(PanelType.ContentEditor).toggleMinimize()),
            gc.register(gs["toggle-browser-panel"].shortcut, () => panelLayout.getByType(PanelType.BrowserPanel).toggleMinimize()),
            gc.register(gs["toggle-tempo-track"].shortcut, () => tempo.setValue(!tempo.getValue())),
            gc.register(gs["toggle-markers-track"].shortcut, () => markers.setValue(!markers.getValue())),
            gc.register(gs["toggle-clips"].shortcut, () => clipsVisibility.setValue(!clipsVisibility.getValue())),
            gc.register(gs["toggle-follow-cursor"].shortcut, () => followCursor.setValue(!followCursor.getValue())),
            gc.register(gs["toggle-metronome"].shortcut, () => metronomeEnabled.setValue(!metronomeEnabled.getValue())),
            gc.register(gs["toggle-loop"].shortcut, () =>
                service.runIfProject(({editing, timelineBox: {loopArea: {enabled}}}) =>
                    editing.modify(() => enabled.setValue(!enabled.getValue())))),
            gc.register(gs["copy-device"].shortcut, () => service.runIfProject(
                ({editing, userEditingManager, skeleton}) => userEditingManager.audioUnit.get().ifSome(({box}) => {
                    const audioUnitBox = asInstanceOf(box, AudioUnitBox)
                    const copies = editing.modify(() => ProjectUtils
                        .extractAudioUnits([audioUnitBox], skeleton), false).unwrap()
                    userEditingManager.audioUnit.edit(copies[0].editing)
                }))),
            gc.register(gs["workspace-next-screen"].shortcut, () => {
                    const keys = Object.entries(DefaultWorkspace).map(([key]) => key as Workspace.ScreenKeys)
                    const screen = service.layout.screen
                    const current = screen.getValue()
                    if (isNull(current) || !keys.includes(current)) {return}
                    screen.setValue(Arrays.getNext(keys, current))
                }
            ),
            gc.register(gs["workspace-prev-screen"].shortcut, () => {
                    const keys = Object.entries(DefaultWorkspace).map(([key]) => key as Workspace.ScreenKeys)
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
            gc.register(gs["show-preferences"].shortcut, () => StudioDialogs.showPreferences())
        )
    }
}