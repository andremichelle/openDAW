import {
    Arrays,
    asInstanceOf,
    isDefined,
    isNull,
    JSONValue,
    Objects,
    RuntimeNotifier,
    Subscription,
    Terminable,
    tryCatch
} from "@opendaw/lib-std"
import {ShortcutDefinitions, ShortcutManager, ShortcutOptions} from "@opendaw/lib-dom"
import {GlobalShortcuts, GlobalShortcutsFactory} from "@/ui/shortcuts/GlobalShortcuts"
import {StudioService} from "@/service/StudioService"
import {DefaultWorkspace} from "@/ui/workspace/Default"
import {PanelType} from "@/ui/workspace/PanelType"
import {Workspace} from "@/ui/workspace/Workspace"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ProjectUtils} from "@opendaw/studio-adapters"
import {StudioDialogs} from "@/service/StudioDialogs"
import {NoteEditorShortcuts, NoteEditorShortcutsFactory} from "@/ui/shortcuts/NoteEditorContext"

export namespace StudioShortcutManager {
    const localStorageKey = "shortcuts"

    const Contexts = {
        "global": {factory: GlobalShortcutsFactory, user: GlobalShortcuts},
        "note-editor": {factory: NoteEditorShortcutsFactory, user: NoteEditorShortcuts}
    } as const satisfies Record<string, any>

    export const reset = (): void => {
        Object.values(Contexts)
            .forEach(definitions => Object.entries(definitions.factory)
                .forEach(([key, {keys}]) => definitions.user[key].keys.overrideWith(keys)))
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
        const {
            engine: {metronomeEnabled},
            panelLayout,
            timeline: {clips: {visible: clipsVisibility}, followCursor, primaryVisibility: {markers, tempo}}
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
        const subscriptions = Terminable.many(
            gc.register(gs["project-undo"].keys, () => service.runIfProject(project => project.editing.undo())),
            gc.register(gs["project-redo"].keys, () => service.runIfProject(project => project.editing.redo())),
            gc.register(gs["project-open"].keys, async () => await service.browseLocalProjects()),
            gc.register(gs["project-save"].keys, async () => await service.projectProfileService.save(),
                ShortcutOptions.of({activeInTextField: true})),
            gc.register(gs["project-save-as"].keys, async () => await service.projectProfileService.saveAs(),
                ShortcutOptions.of({activeInTextField: true})),
            gc.register(gs["toggle-playback"].keys, () => {
                const {engine} = service
                const isPlaying = engine.isPlaying.getValue()
                if (isPlaying) {engine.stop()} else {engine.play()}
            }),
            gc.register(gs["toggle-software-keyboard"].keys, () => service.toggleSoftwareKeyboard()),
            gc.register(gs["toggle-device-panel"].keys, () => panelLayout.getByType(PanelType.DevicePanel).toggleMinimize()),
            gc.register(gs["toggle-content-editor-panel"].keys, () => panelLayout.getByType(PanelType.ContentEditor).toggleMinimize()),
            gc.register(gs["toggle-browser-panel"].keys, () => panelLayout.getByType(PanelType.BrowserPanel).toggleMinimize()),
            gc.register(gs["toggle-tempo-track"].keys, () => tempo.setValue(!tempo.getValue())),
            gc.register(gs["toggle-markers-track"].keys, () => markers.setValue(!markers.getValue())),
            gc.register(gs["toggle-clips"].keys, () => clipsVisibility.setValue(!clipsVisibility.getValue())),
            gc.register(gs["toggle-follow-cursor"].keys, () => followCursor.setValue(!followCursor.getValue())),
            gc.register(gs["toggle-metronome"].keys, () => metronomeEnabled.setValue(!metronomeEnabled.getValue())),
            gc.register(gs["toggle-loop"].keys, () =>
                service.runIfProject(({editing, timelineBox: {loopArea: {enabled}}}) =>
                    editing.modify(() => enabled.setValue(!enabled.getValue())))),
            gc.register(gs["copy-device"].keys, () => service.runIfProject(
                ({editing, userEditingManager, skeleton}) => userEditingManager.audioUnit.get().ifSome(({box}) => {
                    const audioUnitBox = asInstanceOf(box, AudioUnitBox)
                    const copies = editing.modify(() => ProjectUtils
                        .extractAudioUnits([audioUnitBox], skeleton), false).unwrap()
                    userEditingManager.audioUnit.edit(copies[0].editing)
                }))),
            gc.register(gs["workspace-next-screen"].keys, () => {
                    const keys = Object.entries(DefaultWorkspace).map(([key]) => key as Workspace.ScreenKeys)
                    const screen = service.layout.screen
                    const current = screen.getValue()
                    if (isNull(current) || !keys.includes(current)) {return}
                    screen.setValue(Arrays.getNext(keys, current))
                }
            ),
            gc.register(gs["workspace-prev-screen"].keys, () => {
                    const keys = Object.entries(DefaultWorkspace).map(([key]) => key as Workspace.ScreenKeys)
                    const screen = service.layout.screen
                    const current = screen.getValue()
                    if (isNull(current) || !keys.includes(current)) {return}
                    screen.setValue(Arrays.getPrev(keys, current))
                }
            ),
            gc.register(gs["workspace-screen-dashboard"].keys, async () => await service.closeProject()),
            gc.register(gs["workspace-screen-default"].keys, () => service.runIfProject(() => service.switchScreen("default"))),
            gc.register(gs["workspace-screen-mixer"].keys, () => service.runIfProject(() => service.switchScreen("mixer"))),
            gc.register(gs["workspace-screen-piano"].keys, () => service.runIfProject(() => service.switchScreen("piano"))),
            gc.register(gs["workspace-screen-project"].keys, () => service.runIfProject(() => service.switchScreen("project"))),
            gc.register(gs["workspace-screen-meter"].keys, () => service.runIfProject(() => service.switchScreen("meter"))),
            gc.register(gs["workspace-screen-shadertoy"].keys, () => service.runIfProject(() => service.switchScreen("shadertoy"))),
            gc.register(gs["show-preferences"].keys, () => StudioDialogs.showPreferences())
        )
        const conflicts = gc.hasConflicts()
        if (conflicts) {
            RuntimeNotifier.info({
                headline: "Shortcut Conflict",
                message: conflicts.join(", ")
            }).then()
        }
        return subscriptions
    }
}