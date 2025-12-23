import {Key, ShortcutKeys, ShortcutManager, ShortcutOptions} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {PanelType} from "@/ui/workspace/PanelType"
import {Arrays, asInstanceOf, isNull, RuntimeNotifier, Subscription, Terminable} from "@opendaw/lib-std"
import {DefaultWorkspace} from "@/ui/workspace/Default"
import {Workspace} from "@/ui/workspace/Workspace"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ProjectUtils} from "@opendaw/studio-adapters"
import {StudioDialogs} from "@/service/StudioDialogs"

export namespace StudioShortcuts {
    const shift = true
    const ctrl = true
    // const alt = true

    const validateActions = <T extends Record<string, { keys: ShortcutKeys }>>(actions: T): T => {
        const entries = Object.entries(actions)
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                if (entries[i][1].keys.equals(entries[j][1].keys)) {
                    alert(`Shortcut conflict: '${entries[i][0]}' and '${entries[j][0]}' both use ${entries[i][1].keys.format()}`)
                }
            }
        }
        return actions
    }

    export const Actions = validateActions({
        "project-new": {keys: ShortcutKeys.of(Key.KeyN, {ctrl})},
        "project-undo": {keys: ShortcutKeys.of(Key.KeyZ, {ctrl})},
        "project-redo": {keys: ShortcutKeys.of(Key.KeyZ, {ctrl, shift})},
        "project-open": {keys: ShortcutKeys.of(Key.KeyO, {ctrl})},
        "project-save": {keys: ShortcutKeys.of(Key.KeyS, {ctrl})},
        "project-save-as": {keys: ShortcutKeys.of(Key.KeyS, {ctrl, shift})},
        "toggle-playback": {keys: ShortcutKeys.of(Key.Space)},
        "toggle-software-keyboard": {keys: ShortcutKeys.of(Key.KeyK, {ctrl})},
        "toggle-device-panel": {keys: ShortcutKeys.of(Key.KeyD, {shift})},
        "toggle-content-editor-panel": {keys: ShortcutKeys.of(Key.KeyE, {shift})},
        "toggle-browser-panel": {keys: ShortcutKeys.of(Key.KeyB, {shift})},
        "toggle-tempo-track": {keys: ShortcutKeys.of(Key.KeyT, {shift})},
        "toggle-markers-track": {keys: ShortcutKeys.of(Key.KeyM, {shift})},
        "toggle-clips": {keys: ShortcutKeys.of(Key.KeyC, {shift})},
        "toggle-follow-cursor": {keys: ShortcutKeys.of(Key.KeyF, {shift})},
        "toggle-metronome": {keys: ShortcutKeys.of(Key.KeyM, {ctrl})},
        "copy-device": {keys: ShortcutKeys.of(Key.KeyD, {ctrl})},
        "workspace-next-screen": {keys: ShortcutKeys.of(Key.Tab)},
        "workspace-prev-screen": {keys: ShortcutKeys.of(Key.Tab, {shift})},
        "workspace-screen-dashboard": {keys: ShortcutKeys.of(Key.Digit0, {shift})},
        "workspace-screen-default": {keys: ShortcutKeys.of(Key.Digit1, {shift})},
        "workspace-screen-mixer": {keys: ShortcutKeys.of(Key.Digit2, {shift})},
        "workspace-screen-piano": {keys: ShortcutKeys.of(Key.Digit3, {shift})},
        "workspace-screen-project": {keys: ShortcutKeys.of(Key.Digit4, {shift})},
        "workspace-screen-shadertoy": {keys: ShortcutKeys.of(Key.Digit5, {shift})},
        "workspace-screen-meter": {keys: ShortcutKeys.of(Key.Digit6, {shift})},
        "show-preferences": {keys: ShortcutKeys.of(Key.Comma, {ctrl})}
    })

    export const install = (service: StudioService): Subscription => {
        const {global: s} = ShortcutManager.get()
        const {
            engine: {metronomeEnabled},
            panelLayout,
            timeline: {clips: {visible: clipsVisibility}, followCursor, primaryVisibility: {markers, tempo}}
        } = service
        const subscriptions = Terminable.many(
            s.register(Actions["project-new"].keys, () => service.newProject()),
            s.register(Actions["project-undo"].keys, () => service.runIfProject(project => project.editing.undo())),
            s.register(Actions["project-redo"].keys, () => service.runIfProject(project => project.editing.redo())),
            s.register(Actions["project-open"].keys, async () => await service.browseLocalProjects()),
            s.register(Actions["project-save"].keys, async () => await service.projectProfileService.save(),
                ShortcutOptions.of({activeInTextField: true})),
            s.register(Actions["project-save-as"].keys, async () => await service.projectProfileService.saveAs(),
                ShortcutOptions.of({activeInTextField: true})),
            s.register(Actions["toggle-playback"].keys, () => {
                const {engine} = service
                const isPlaying = engine.isPlaying.getValue()
                if (isPlaying) {engine.stop()} else {engine.play()}
            }),
            s.register(Actions["toggle-software-keyboard"].keys, () => service.toggleSoftwareKeyboard()),
            s.register(Actions["toggle-device-panel"].keys, () => panelLayout.getByType(PanelType.DevicePanel).toggleMinimize()),
            s.register(Actions["toggle-content-editor-panel"].keys, () => panelLayout.getByType(PanelType.ContentEditor).toggleMinimize()),
            s.register(Actions["toggle-browser-panel"].keys, () => panelLayout.getByType(PanelType.BrowserPanel).toggleMinimize()),
            s.register(Actions["toggle-tempo-track"].keys, () => tempo.setValue(!tempo.getValue())),
            s.register(Actions["toggle-markers-track"].keys, () => markers.setValue(!markers.getValue())),
            s.register(Actions["toggle-clips"].keys, () => clipsVisibility.setValue(!clipsVisibility.getValue())),
            s.register(Actions["toggle-follow-cursor"].keys, () => followCursor.setValue(!followCursor.getValue())),
            s.register(Actions["toggle-metronome"].keys, () => metronomeEnabled.setValue(!metronomeEnabled.getValue())),
            s.register(Actions["copy-device"].keys, () => service.runIfProject(
                ({editing, userEditingManager, skeleton}) => userEditingManager.audioUnit.get().ifSome(({box}) => {
                    const audioUnitBox = asInstanceOf(box, AudioUnitBox)
                    const copies = editing.modify(() => ProjectUtils
                        .extractAudioUnits([audioUnitBox], skeleton), false).unwrap()
                    userEditingManager.audioUnit.edit(copies[0].editing)
                }))),
            s.register(Actions["workspace-next-screen"].keys, () => {
                    const keys = Object.entries(DefaultWorkspace).map(([key]) => key as Workspace.ScreenKeys)
                    const screen = service.layout.screen
                    const current = screen.getValue()
                    if (isNull(current) || !keys.includes(current)) {return}
                    screen.setValue(Arrays.getNext(keys, current))
                }
            ),
            s.register(Actions["workspace-prev-screen"].keys, () => {
                    const keys = Object.entries(DefaultWorkspace).map(([key]) => key as Workspace.ScreenKeys)
                    const screen = service.layout.screen
                    const current = screen.getValue()
                    if (isNull(current) || !keys.includes(current)) {return}
                    screen.setValue(Arrays.getPrev(keys, current))
                }
            ),
            s.register(Actions["workspace-screen-dashboard"].keys, async () => await service.closeProject()),
            s.register(Actions["workspace-screen-default"].keys, () => service.runIfProject(() => service.switchScreen("default"))),
            s.register(Actions["workspace-screen-mixer"].keys, () => service.runIfProject(() => service.switchScreen("mixer"))),
            s.register(Actions["workspace-screen-piano"].keys, () => service.runIfProject(() => service.switchScreen("piano"))),
            s.register(Actions["workspace-screen-project"].keys, () => service.runIfProject(() => service.switchScreen("project"))),
            s.register(Actions["workspace-screen-meter"].keys, () => service.runIfProject(() => service.switchScreen("meter"))),
            s.register(Actions["workspace-screen-shadertoy"].keys, () => service.runIfProject(() => service.switchScreen("shadertoy"))),
            s.register(Actions["show-preferences"].keys, () => StudioDialogs.showPreferences())
        )
        const conflicts = s.hasConflicts()
        if (conflicts) {
            RuntimeNotifier.info({
                headline: "Shortcut Conflict",
                message: conflicts.join(", ")
            }).then()
        }
        return subscriptions
    }
}