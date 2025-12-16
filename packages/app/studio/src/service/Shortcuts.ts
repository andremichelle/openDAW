import {StudioService} from "@/service/StudioService"
import {PanelType} from "@/ui/workspace/PanelType"
import {Events, Keyboard} from "@opendaw/lib-dom"
import {DefaultWorkspace} from "@/ui/workspace/Default"
import {Arrays, asInstanceOf, isNull} from "@opendaw/lib-std"
import {Workspace} from "@/ui/workspace/Workspace"
import {Surface} from "@/ui/surface/Surface"
import {ProjectUtils} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"

export class Shortcuts {
    constructor(service: StudioService) {
        Surface.subscribeKeyboard("keydown", async (event: KeyboardEvent) => {
            if (Events.isTextInput(event.target)) {return}
            if (event.repeat) {
                event.preventDefault()
                return
            }
            const code = event.code
            if (Keyboard.isControlKey(event) && event.shiftKey && code === "KeyS") {
                event.preventDefault()
                await service.projectProfileService.saveAs()
            } else if (Keyboard.isControlKey(event) && code === "KeyS") {
                event.preventDefault()
                await service.projectProfileService.save()
            } else if (Keyboard.isControlKey(event) && code === "KeyO") {
                event.preventDefault()
                await service.browseLocalProjects()
            } else if (Keyboard.isControlKey(event) && code === "KeyK") {
                service.toggleSoftwareKeyboard()
                event.preventDefault()
            } else if (code === "Space") {
                event.preventDefault()
                const engine = service.engine
                const isPlaying = engine.isPlaying.getValue()
                if (isPlaying) {
                    engine.stop()
                } else {
                    engine.play()
                }
            } else if (code === "KeyE") {
                service.panelLayout.getByType(PanelType.ContentEditor).toggleMinimize()
                event.preventDefault()
            } else if (code === "KeyB") {
                service.panelLayout.getByType(PanelType.BrowserPanel).toggleMinimize()
                event.preventDefault()
            } else if (code === "KeyD") {
                if (Keyboard.isControlKey(event)) {
                    const {project: {editing, userEditingManager, skeleton}} = service
                    userEditingManager.audioUnit.get().ifSome(({box}) => {
                        const audioUnitBox = asInstanceOf(box, AudioUnitBox)
                        const copies = editing.modify(() => ProjectUtils
                            .extractAudioUnits([audioUnitBox], skeleton), false).unwrap()
                        userEditingManager.audioUnit.edit(copies[0].editing)
                    })
                } else {
                    service.panelLayout.getByType(PanelType.DevicePanel).toggleMinimize()
                }
                event.preventDefault()
            } else if (code === "KeyM") {
                service.panelLayout.getByType(PanelType.Mixer).toggleMinimize()
                event.preventDefault()
            } else if (code === "Tab") {
                event.preventDefault()
                const keys = Object.entries(DefaultWorkspace)
                    .filter((entry: [string, Workspace.Screen]) => !entry[1].hidden)
                    .map(([key]) => key as Workspace.ScreenKeys)
                const screen = service.layout.screen
                const current = screen.getValue()
                if (isNull(current) || !keys.includes(current)) {return}
                if (event.shiftKey) {
                    screen.setValue(Arrays.getPrev(keys, current))
                } else {
                    screen.setValue(Arrays.getNext(keys, current))
                }
                event.preventDefault()
            } else if (event.shiftKey) {
                if (code === "Digit0") {
                    await service.closeProject()
                } else if (code === "Digit1") {
                    if (service.hasProfile) {
                        service.switchScreen("default")
                    }
                } else if (code === "Digit2") {
                    if (service.hasProfile) {
                        service.switchScreen("mixer")
                    }
                } else if (code === "Digit3") {
                    if (service.hasProfile) {
                        service.switchScreen("modular")
                    }
                } else if (code === "Digit4") {
                    if (service.hasProfile) {
                        service.switchScreen("piano")
                    }
                } else if (code === "Digit5") {
                    if (service.hasProfile) {
                        service.switchScreen("project")
                    }
                } else if (code === "Digit6") {
                    if (service.hasProfile) {
                        service.switchScreen("meter")
                    }
                }
            }
        })
    }
}