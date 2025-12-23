import {ShortcutManager, ShortcutOptions} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {PanelType} from "@/ui/workspace/PanelType"
import {Arrays, asInstanceOf, isNull, RuntimeNotifier, Subscription, Terminable} from "@opendaw/lib-std"
import {DefaultWorkspace} from "@/ui/workspace/Default"
import {Workspace} from "@/ui/workspace/Workspace"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ProjectUtils} from "@opendaw/studio-adapters"
import {StudioDialogs} from "@/service/StudioDialogs"
import {GlobalShortcuts} from "@/shortcuts/GlobalShortcuts"

export namespace StudioShortcutManager {
    export const install = (service: StudioService): Subscription => {
        const {global: g} = ShortcutManager.get()
        const {
            engine: {metronomeEnabled},
            panelLayout,
            timeline: {clips: {visible: clipsVisibility}, followCursor, primaryVisibility: {markers, tempo}}
        } = service
        const s = GlobalShortcuts
        const subscriptions = Terminable.many(
            g.register(s["project-undo"].keys, () => service.runIfProject(project => project.editing.undo())),
            g.register(s["project-redo"].keys, () => service.runIfProject(project => project.editing.redo())),
            g.register(s["project-open"].keys, async () => await service.browseLocalProjects()),
            g.register(s["project-save"].keys, async () => await service.projectProfileService.save(),
                ShortcutOptions.of({activeInTextField: true})),
            g.register(s["project-save-as"].keys, async () => await service.projectProfileService.saveAs(),
                ShortcutOptions.of({activeInTextField: true})),
            g.register(s["toggle-playback"].keys, () => {
                const {engine} = service
                const isPlaying = engine.isPlaying.getValue()
                if (isPlaying) {engine.stop()} else {engine.play()}
            }),
            g.register(s["toggle-software-keyboard"].keys, () => service.toggleSoftwareKeyboard()),
            g.register(s["toggle-device-panel"].keys, () => panelLayout.getByType(PanelType.DevicePanel).toggleMinimize()),
            g.register(s["toggle-content-editor-panel"].keys, () => panelLayout.getByType(PanelType.ContentEditor).toggleMinimize()),
            g.register(s["toggle-browser-panel"].keys, () => panelLayout.getByType(PanelType.BrowserPanel).toggleMinimize()),
            g.register(s["toggle-tempo-track"].keys, () => tempo.setValue(!tempo.getValue())),
            g.register(s["toggle-markers-track"].keys, () => markers.setValue(!markers.getValue())),
            g.register(s["toggle-clips"].keys, () => clipsVisibility.setValue(!clipsVisibility.getValue())),
            g.register(s["toggle-follow-cursor"].keys, () => followCursor.setValue(!followCursor.getValue())),
            g.register(s["toggle-metronome"].keys, () => metronomeEnabled.setValue(!metronomeEnabled.getValue())),
            g.register(s["copy-device"].keys, () => service.runIfProject(
                ({editing, userEditingManager, skeleton}) => userEditingManager.audioUnit.get().ifSome(({box}) => {
                    const audioUnitBox = asInstanceOf(box, AudioUnitBox)
                    const copies = editing.modify(() => ProjectUtils
                        .extractAudioUnits([audioUnitBox], skeleton), false).unwrap()
                    userEditingManager.audioUnit.edit(copies[0].editing)
                }))),
            g.register(s["workspace-next-screen"].keys, () => {
                    const keys = Object.entries(DefaultWorkspace).map(([key]) => key as Workspace.ScreenKeys)
                    const screen = service.layout.screen
                    const current = screen.getValue()
                    if (isNull(current) || !keys.includes(current)) {return}
                    screen.setValue(Arrays.getNext(keys, current))
                }
            ),
            g.register(s["workspace-prev-screen"].keys, () => {
                    const keys = Object.entries(DefaultWorkspace).map(([key]) => key as Workspace.ScreenKeys)
                    const screen = service.layout.screen
                    const current = screen.getValue()
                    if (isNull(current) || !keys.includes(current)) {return}
                    screen.setValue(Arrays.getPrev(keys, current))
                }
            ),
            g.register(s["workspace-screen-dashboard"].keys, async () => await service.closeProject()),
            g.register(s["workspace-screen-default"].keys, () => service.runIfProject(() => service.switchScreen("default"))),
            g.register(s["workspace-screen-mixer"].keys, () => service.runIfProject(() => service.switchScreen("mixer"))),
            g.register(s["workspace-screen-piano"].keys, () => service.runIfProject(() => service.switchScreen("piano"))),
            g.register(s["workspace-screen-project"].keys, () => service.runIfProject(() => service.switchScreen("project"))),
            g.register(s["workspace-screen-meter"].keys, () => service.runIfProject(() => service.switchScreen("meter"))),
            g.register(s["workspace-screen-shadertoy"].keys, () => service.runIfProject(() => service.switchScreen("shadertoy"))),
            g.register(s["show-preferences"].keys, () => StudioDialogs.showPreferences())
        )
        const conflicts = g.hasConflicts()
        if (conflicts) {
            RuntimeNotifier.info({
                headline: "Shortcut Conflict",
                message: conflicts.join(", ")
            }).then()
        }
        return subscriptions
    }
}