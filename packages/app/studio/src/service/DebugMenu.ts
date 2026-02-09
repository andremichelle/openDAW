import {isDefined, panic, RuntimeNotifier, RuntimeSignal} from "@moises-ai/lib-std"
import {MenuItem, ProjectSignals, StudioPreferences, Workers} from "@moises-ai/studio-core"
import {Promises} from "@moises-ai/lib-runtime"
import {RouteLocation} from "@moises-ai/lib-jsx"
import {Browser} from "@moises-ai/lib-dom"
import {CodecsUtils} from "@/CodecsUtils"
import {StudioService} from "@/service/StudioService"
import {IconSymbol} from "@moises-ai/studio-enums"
import {SyncLogService} from "@/service/SyncLogService"
import {Dialogs} from "@/ui/components/dialogs"

export const createDebugMenu = (service: StudioService) => MenuItem.default({
    label: "Debug",
    separatorBefore: true,
    hidden: !StudioPreferences.settings.debug["enable-debug-menu"]
}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
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
    MenuItem.default({label: "List Supported Codecs...", separatorBefore: true})
        .setTriggerProcedure(() => CodecsUtils.listSupportedCodecs()),
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