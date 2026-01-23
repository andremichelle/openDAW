import {EmptyExec, isAbsent, RuntimeNotifier} from "@opendaw/lib-std"
import {Browser, Files} from "@opendaw/lib-dom"
import {RouteLocation} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {CloudBackup, FilePickerAcceptTypes, MenuItem, StudioPreferences, YService} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {VideoRenderer} from "@/video/VideoRenderer"
import {createDebugMenu} from "@/service/DebugMenu"

export const populateStudioMenu = (service: StudioService) => {
    const Global = GlobalShortcuts
    return MenuItem.root()
        .setRuntimeChildrenProcedure(parent => {
                parent.addMenuItem(
                    MenuItem.header({label: "openDAW", icon: IconSymbol.OpenDAW, color: Colors.green}),
                    MenuItem.default({
                        label: "Dashboard",
                        shortcut: Global["workspace-screen-dashboard"].shortcut.format()
                    }).setTriggerProcedure(() => service.closeProject()),
                    MenuItem.default({
                        label: "New",
                        separatorBefore: true
                    }).setTriggerProcedure(() => service.newProject()),
                    MenuItem.default({
                        label: "Open...",
                        shortcut: Global["project-open"].shortcut.format()
                    }).setTriggerProcedure(() => service.browseLocalProjects()),
                    MenuItem.default({
                        label: "Save",
                        shortcut: Global["project-save"].shortcut.format(),
                        selectable: service.hasProfile
                    }).setTriggerProcedure(() => service.projectProfileService.save()),
                    MenuItem.default({
                        label: "Save As...",
                        shortcut: Global["project-save-as"].shortcut.format(),
                        selectable: service.hasProfile
                    }).setTriggerProcedure(() => service.projectProfileService.saveAs()),
                    MenuItem.default({label: "Import", separatorBefore: true})
                        .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                            MenuItem.default({label: "Audio Files..."})
                                .setTriggerProcedure(() => service.sampleService.browse(true)),
                            MenuItem.default({label: "Soundfont Files..."})
                                .setTriggerProcedure(() => service.soundfontService.browse(true)),
                            MenuItem.default({label: "Project Bundle..."})
                                .setTriggerProcedure(() => service.importBundle()),
                            MenuItem.default({label: "DAWproject..."})
                                .setTriggerProcedure(() => service.importDawproject().then(EmptyExec, EmptyExec)),
                            MenuItem.default({label: "Preset..."})
                                .setTriggerProcedure(() => service.importPreset().then(EmptyExec))
                        )),
                    MenuItem.default({label: "Export", selectable: service.hasProfile})
                        .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                            MenuItem.default({label: "Mixdown...", selectable: service.hasProfile})
                                .setTriggerProcedure(() => service.exportMixdown()),
                            MenuItem.default({label: "Stems...", selectable: service.hasProfile})
                                .setTriggerProcedure(() => service.exportStems()),
                            MenuItem.default({label: "Project Bundle...", selectable: service.hasProfile})
                                .setTriggerProcedure(() => service.exportBundle()),
                            MenuItem.default({label: "DAWproject...", selectable: service.hasProfile})
                                .setTriggerProcedure(async () => service.exportDawproject()),
                            MenuItem.default({
                                label: "JSON...",
                                selectable: service.hasProfile,
                                hidden: !Browser.isLocalHost()
                            }).setTriggerProcedure(async () => {
                                const arrayBuffer = new TextEncoder().encode(JSON.stringify(
                                    service.project.boxGraph.toJSON(), null, 2)).buffer
                                await Files.save(arrayBuffer, {
                                    types: [FilePickerAcceptTypes.JsonFileType],
                                    suggestedName: "project.json"
                                })
                            }),
                            MenuItem.default({
                                label: "Video...",
                                selectable: service.hasProfile
                            }).setTriggerProcedure(async () => Promises.tryCatch(VideoRenderer.render(
                                service.project, service.profile.meta.name, service.project.engine.sampleRate)))
                        )),
                    MenuItem.default({label: "Cloud Backup"})
                        .setRuntimeChildrenProcedure(parent => {
                            parent.addMenuItem(
                                MenuItem.default({
                                    label: "Dropbox",
                                    icon: IconSymbol.Dropbox
                                }).setTriggerProcedure(() =>
                                    CloudBackup.backup(service.cloudAuthManager, "Dropbox").catch(EmptyExec)),
                                MenuItem.default({
                                    label: "GoogleDrive",
                                    icon: IconSymbol.GoogleDrive
                                }).setTriggerProcedure(() =>
                                    CloudBackup.backup(service.cloudAuthManager, "GoogleDrive").catch(EmptyExec)),
                                MenuItem.default({label: "Help", icon: IconSymbol.Help, separatorBefore: true})
                                    .setTriggerProcedure(() => RouteLocation.get().navigateTo("/manuals/cloud-backup"))
                            )
                        }),
                    MenuItem.default({label: "Window", separatorBefore: true})
                        .setRuntimeChildrenProcedure(parent => {
                            return parent.addMenuItem(
                                MenuItem.default({
                                    label: "Show MIDI-Keyboard",
                                    shortcut: GlobalShortcuts["toggle-software-keyboard"].shortcut.format(),
                                    checked: service.isSoftwareKeyboardVisible()
                                }).setTriggerProcedure(() => service.toggleSoftwareKeyboard())
                            )
                        }),
                    MenuItem.default({
                        label: "Experimental Features",
                        hidden: !StudioPreferences.settings.debug["enable-beta-features"],
                        separatorBefore: true
                    }).setRuntimeChildrenProcedure(parent => {
                        parent.addMenuItem(
                            MenuItem.default({label: "Connect Room..."})
                                .setTriggerProcedure(async () => {
                                    const roomName = prompt("Enter a room name:", "")
                                    if (isAbsent(roomName)) {return}
                                    const dialog = RuntimeNotifier.progress({
                                        headline: "Connecting to Room...",
                                        message: "Please wait while we connect to the room..."
                                    })
                                    const {status, value: project, error} = await Promises.tryCatch(
                                        YService.getOrCreateRoom(service.projectProfileService.getValue()
                                            .map(profile => profile.project), service, roomName))
                                    if (status === "resolved") {
                                        service.projectProfileService.setProject(project, roomName)
                                    } else {
                                        await RuntimeNotifier.info({
                                            headline: "Failed Connecting Room",
                                            message: String(error)
                                        })
                                    }
                                    dialog.terminate()
                                })
                        )
                    }),
                    MenuItem.default({label: "Script Editor", separatorBefore: true})
                        .setTriggerProcedure(() => RouteLocation.get().navigateTo("/scripting")),
                    MenuItem.default({
                        label: "Preferences",
                        shortcut: GlobalShortcuts["show-preferences"].shortcut.format(),
                        separatorBefore: true
                    }).setTriggerProcedure(() => RouteLocation.get().navigateTo("/preferences")),
                    createDebugMenu(service)
                )
            }
        )
}