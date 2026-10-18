import {EmptyExec} from "@opendaw/lib-std"
import {Files, Platform, Shortcut} from "@opendaw/lib-dom"
import {RouteLocation} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {CloudBackup, FilePickerAcceptTypes, MenuItem} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {Workspace} from "@/ui/workspace/Workspace"
import {VideoRenderer} from "@/video/VideoRenderer"
import {createDebugMenu} from "@/service/DebugMenu"
import {connectRoom} from "@/service/StudioLiveRoomConnect"
import {NeuralDemux} from "@/service/NeuralDemux.tsx"
import {NextcloudDialogs} from "@/project/NextcloudDialogs"
import {openManual} from "@/ui/manuals"
import {openAudioOutputSettings} from "@/ui/mixer/AudioOutputSelector"
import {NativePluginHost} from "@/platform/desktop/NativePluginHost"
import {Shell} from "@/platform/desktop/Shell"
import {openNativePluginsDialog} from "@/platform/desktop/NativePluginsDialog"
import type {NativePluginInfo} from "@/platform/desktop/engine/NativePlugins"

export namespace DesktopStudioMenu {
    export type NativeRole = "about" | "services" | "hide" | "hide-others" | "show-all" | "quit"
        | "cut" | "copy" | "paste" | "select-all" | "minimize" | "zoom" | "fullscreen" | "close-window" | "separator"
        | "zoom-in" | "zoom-out" | "zoom-reset"
    export type Entry = MenuItem | NativeRole
    export type Menu = { label: string, role?: "window" | "help", entries: ReadonlyArray<Entry> }

    // the page handles a shortcut first, the native accelerator only fires where the page leaves the key alone
    export const shortcuts = new WeakMap<MenuItem, Shortcut>()

    export const create = (service: StudioService): ReadonlyArray<Menu> => {
        const item = (label: string, trigger: () => unknown, selectable: boolean = true) =>
            MenuItem.default({label, selectable}).setTriggerProcedure(() => {trigger()})
        const screen = (label: string, key: Workspace.ScreenKeys, shortcut: keyof typeof GlobalShortcuts) =>
            withShortcut(item(label, () => service.runIfProject(() => service.switchScreen(key)), service.hasProfile), shortcut)
        const navigate = (label: string, path: string) => item(label, () => RouteLocation.get().navigateTo(path))
        const withShortcut = (menuItem: MenuItem, key: keyof typeof GlobalShortcuts): MenuItem => {
            shortcuts.set(menuItem, GlobalShortcuts[key].shortcut)
            return menuItem
        }
        // grouped by vendor, a plugin is added to the open project
        const pluginsMenu = (label: string, kind: NativePluginInfo["kind"], create: (plugin: NativePluginInfo) => void): MenuItem =>
            MenuItem.default({label}).setRuntimeChildrenProcedure(parent => {
                const plugins = NativePluginHost.plugins().filter(plugin => plugin.kind === kind && plugin.status === "ok")
                if (plugins.length === 0) {
                    parent.addMenuItem(MenuItem.default({
                        label: NativePluginHost.isScanning() ? "Scanning…" : `No ${label.toLowerCase()} found`, selectable: false
                    }))
                    return
                }
                const vendors = Array.from(new Set(plugins.map(plugin => plugin.vendor)))
                parent.addMenuItem(...vendors.map(vendor => MenuItem.default({label: vendor.length > 0 ? vendor : "Unknown"})
                    .setRuntimeChildrenProcedure(sub => sub.addMenuItem(...plugins.filter(plugin => plugin.vendor === vendor)
                        .map(plugin => item(plugin.name, () => create(plugin), service.hasProfile))))))
            })
        return [
            {
                label: "openDAW Studio", entries: [
                    "about", "separator",
                    withShortcut(navigate("Preferences...", "/preferences"), "show-preferences"),
                    item("Audio Settings...", () => openAudioOutputSettings(service.audioDevices)),
                    navigate("Storage", "/storage"),
                    "separator", "services", "separator", "hide", "hide-others", "show-all", "separator", "quit"
                ]
            },
            {
                label: "File", entries: [
                    withShortcut(item("Dashboard", () => service.closeProject()), "workspace-screen-dashboard"),
                    item("New", () => service.newProject()).addSeparatorBefore(),
                    withShortcut(item("Open...", () => service.browseLocalProjects()), "project-open"),
                    withShortcut(item("Save", () => service.projectProfileService.save(), service.hasProfile), "project-save"),
                    withShortcut(item("Save As...", () => service.projectProfileService.saveAs(), service.hasProfile), "project-save-as"),
                    item("Save as Template...", () => service.projectProfileService.saveAsTemplate(), service.hasProfile),
                    item("Save Bundle File to Disk...", () => service.exportBundle(), service.hasProfile),
                    item("Open Bundle File from Disk...", () => service.importBundle()),
                    MenuItem.default({label: "Import", separatorBefore: true}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                        item("Audio Files...", () => service.sampleService.browse(true)),
                        item("Stems (Zip)...", () => service.importStems()),
                        item("Soundfont Files...", () => service.soundfontService.browse(true)),
                        item("Preset Bundle...", () => service.importPreset().then(EmptyExec)),
                        item("DAWproject...", () => service.importDawproject().then(EmptyExec, EmptyExec))
                    )),
                    MenuItem.default({label: "Export", selectable: service.hasProfile}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                        item("Mixdown...", () => service.exportMixdown(), service.hasProfile),
                        item("Stems...", () => service.exportStems(), service.hasProfile),
                        item("DAWproject...", () => service.exportDawproject(), service.hasProfile),
                        item("JSON...", () => Files.save(new TextEncoder().encode(JSON.stringify(
                            service.project.boxGraph.toJSON(), null, 2)).buffer, {
                            types: [FilePickerAcceptTypes.JsonFileType], suggestedName: "project.json"
                        }), service.hasProfile).isHidden(!Platform.isDevelopment()),
                        item("Video...", () => Promises.tryCatch(VideoRenderer.render(
                            service.project, service.profile.meta.name, service.project.engine.sampleRate)), service.hasProfile)
                    )),
                    MenuItem.default({label: "Backup", separatorBefore: true}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                        item("Dropbox", () => CloudBackup.backup(service.cloudAuthManager, "Dropbox").catch(EmptyExec)),
                        item("Google Drive", () => CloudBackup.backup(service.cloudAuthManager, "GoogleDrive").catch(EmptyExec)),
                        item("Help", () => openManual("/manuals/cloud-backup")).addSeparatorBefore()
                    )),
                    MenuItem.default({label: "Nextcloud"}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                        item("Browse projects...", () => NextcloudDialogs.browse(service)),
                        item("Upload project...", () => NextcloudDialogs.save(service), service.hasProfile),
                        item("Help", () => openManual("/manuals/nextcloud")).addSeparatorBefore()
                    ))
                ]
            },
            {
                label: "Edit", entries: [
                    item("Undo", () => service.runIfProject(project => project.editing.undo()), service.hasProfile),
                    item("Redo", () => service.runIfProject(project => project.editing.redo()), service.hasProfile),
                    "separator", "cut", "copy", "paste", "select-all"
                ]
            },
            {
                label: "View", entries: [
                    withShortcut(MenuItem.default({label: "Show MIDI-Keyboard", checked: service.isSoftwareKeyboardVisible()})
                        .setTriggerProcedure(() => service.toggleSoftwareKeyboard()), "toggle-software-keyboard"),
                    screen("Arrangement", "default", "workspace-screen-default").addSeparatorBefore(),
                    screen("Mixer", "mixer", "workspace-screen-mixer"),
                    screen("Piano Roll", "piano", "workspace-screen-piano"),
                    screen("Project", "project", "workspace-screen-project"),
                    screen("Shader Visualizer", "shadertoy", "workspace-screen-shadertoy"),
                    screen("Modulation", "modulation", "workspace-screen-modulation"),
                    screen("Tap Tempo", "tap", "workspace-screen-tap"),
                    "separator", "zoom-in", "zoom-out", "zoom-reset", "separator", "fullscreen"
                ]
            },
            {
                label: "Tools", entries: [
                    navigate("Script Editor", "/scripting"),
                    item("Join Live Room...", () => connectRoom(service)),
                    item("Neural Demux...", () => NeuralDemux.run(service).catch(EmptyExec)),
                    navigate("Statistics", "/stats").addSeparatorBefore(),
                    item("Web Inspector", () => Shell.request("inspector", {})),
                    item("Show Log Files", () => Shell.request("logs", {})),
                    // apps before shell api 3 cannot uninstall
                    item("Uninstall openDAW...", () => Shell.request("uninstall", {}), Shell.info().api >= 3).addSeparatorBefore()
                ]
            },
            {
                label: "Plugins", entries: [
                    pluginsMenu("Instruments", "instrument", plugin => NativePluginHost.createInstrument(service, plugin)),
                    pluginsMenu("Effects", "effect", plugin => NativePluginHost.createEffect(service, plugin)),
                    item("Manage Plugins…", () => openNativePluginsDialog()).addSeparatorBefore()
                ]
            },
            {label: "Window", role: "window", entries: ["minimize", "zoom"]},
            {
                label: "Help", role: "help", entries: [
                    item("Manuals", () => openManual("/manuals/")),
                    createDebugMenu(service).addSeparatorBefore()
                ]
            }
        ]
    }
}
