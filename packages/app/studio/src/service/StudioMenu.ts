import {EmptyExec, isAbsent, isDefined, panic, RuntimeNotifier, RuntimeSignal} from "@opendaw/lib-std"
import {Browser, Files} from "@opendaw/lib-dom"
import {RouteLocation} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {
    CloudBackup,
    FilePickerAcceptTypes,
    MenuItem,
    ProjectSignals,
    StudioPreferences,
    Workers,
    YService
} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {SyncLogService} from "@/service/SyncLogService"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {StudioDialogs} from "@/service/StudioDialogs"

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
                            MenuItem.default({
                                label: "Mixdown [Worker]...",
                                selectable: service.hasProfile,
                                hidden: !Browser.isLocalHost()
                            }).setTriggerProcedure(() => service.exportMixdownWorker()),
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
                            })
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
                        hidden: !StudioPreferences.settings["enable-beta-features"],
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
                        label: "Shortcuts",
                        separatorBefore: true
                    }).setTriggerProcedure(async () => StudioDialogs.showShortcutManager()),
                    MenuItem.default({
                        label: "Preferences",
                        shortcut: GlobalShortcuts["show-preferences"].shortcut.format()
                    }).setTriggerProcedure(() => RouteLocation.get().navigateTo("/preferences")),
                    MenuItem.default({label: "Debug", separatorBefore: true})
                        .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                            MenuItem.header({label: "Debugging", icon: IconSymbol.System}),
                            MenuItem.default({
                                label: "New SyncLog...",
                                selectable: isDefined(window.showSaveFilePicker)
                            }).setTriggerProcedure(() => SyncLogService.start(service)),
                            MenuItem.default({
                                label: "Open SyncLog...",
                                selectable: isDefined(window.showOpenFilePicker)
                            }).setTriggerProcedure(() => SyncLogService.append(service)),
                            MenuItem.default({
                                label: "Show Boxes...",
                                selectable: service.hasProfile,
                                separatorBefore: true
                            }).setTriggerProcedure(() => Dialogs.debugBoxes(service.project.boxGraph)),
                            MenuItem.default({label: "Validate Project...", selectable: service.hasProfile})
                                .setTriggerProcedure(() => service.verifyProject()),
                            MenuItem.default({
                                label: "Load file...",
                                separatorBefore: true
                            }).setTriggerProcedure(() => service.projectProfileService.loadFile()),
                            MenuItem.default({
                                label: "Save file...",
                                selectable: service.hasProfile
                            }).setTriggerProcedure(() => service.projectProfileService.saveFile()),
                            MenuItem.header({label: "Pages", icon: IconSymbol.Box}),
                            MenuItem.default({label: "・ Icons"})
                                .setTriggerProcedure(() => RouteLocation.get().navigateTo("/icons")),
                            MenuItem.default({label: "・ Components"})
                                .setTriggerProcedure(() => RouteLocation.get().navigateTo("/components")),
                            MenuItem.default({label: "・ Automation"})
                                .setTriggerProcedure(() => RouteLocation.get().navigateTo("/automation")),
                            MenuItem.default({label: "・ Errors"})
                                .setTriggerProcedure(() => RouteLocation.get().navigateTo("/errors")),
                            MenuItem.default({label: "・ Graph"})
                                .setTriggerProcedure(() => RouteLocation.get().navigateTo("/graph")),
                            MenuItem.default({
                                label: "Throw an error in main-thread 💣",
                                separatorBefore: true,
                                hidden: !Browser.isLocalHost() && location.hash !== "#admin"
                            }).setTriggerProcedure(() => panic("An error has been emulated")),
                            MenuItem.default({
                                label: "Throw an error in audio-worklet 💣",
                                hidden: !Browser.isLocalHost()
                            }).setTriggerProcedure(() => service.panicEngine()),
                            MenuItem.default({label: "Clear Local Storage", separatorBefore: true})
                                .setTriggerProcedure(async () => {
                                    const approved = await RuntimeNotifier.approve({
                                        headline: "Clear Local Storage",
                                        message: "Are you sure? All your samples and projects will be deleted.\nThis cannot be undone!"
                                    })
                                    if (approved) {
                                        const {status, error} =
                                            await Promises.tryCatch(Workers.Opfs.delete(""))
                                        if (status === "resolved") {
                                            RuntimeSignal.dispatch(ProjectSignals.StorageUpdated)
                                            await RuntimeNotifier.info({
                                                headline: "Clear Local Storage",
                                                message: "Your Local Storage is cleared"
                                            })
                                        } else {
                                            await RuntimeNotifier.info({
                                                headline: "Clear Local Storage",
                                                message: String(error)
                                            })
                                        }
                                    }
                                })
                        ))
                )
            }
        )
}