import {Notifier, Objects, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Dialogs} from "@/ui/components/dialogs"
import {ShortcutManagerView} from "@/ui/components/ShortcutManagerView"
import {StudioShortcutManager} from "@/service/StudioShortcutManager"
import {Files, ShortcutDefinitions} from "@opendaw/lib-dom"
import {FilePickerAcceptTypes} from "@opendaw/studio-core"

export namespace StudioDialogs {
    export const showShortcutManager = async () => {
        const lifecycle = new Terminator()
        const abortController = new AbortController()
        const updateNotifier = new Notifier<void>()

        const contexts: StudioShortcutManager.ShortcutsMap = {}
        Objects.entries(StudioShortcutManager.Contexts).forEach(([key, shortcuts]) =>
            contexts[key] = ShortcutDefinitions.copy(shortcuts.workingDefinition))

        await Promises.tryCatch(Dialogs.show({
            headline: "Shortcut Manager",
            content: ShortcutManagerView({lifecycle, contexts, updateNotifier}),
            growWidth: true,
            abortSignal: abortController.signal,
            okText: "Apply",
            buttons: [
                {
                    text: "Load", onClick: async () => {
                        const {status, value: jsonString, error} = await Promises
                            .tryCatch(Files.open({types: [FilePickerAcceptTypes.JsonFileType]})
                                .then(([file]) => file.text()))
                        if (status === "resolved") {
                            StudioShortcutManager.fromJSONString(contexts, jsonString)
                            updateNotifier.notify()
                        } else {
                            console.warn(error)
                        }
                    }
                },
                {
                    text: "Save", onClick: () => StudioShortcutManager.toJSONString(contexts)
                        .ifSome(jsonString => Files.save(new TextEncoder().encode(jsonString).buffer,
                            {suggestedName: "openDAW.shortcuts.json"}))
                },
                {
                    text: "Reset", onClick: () => {
                        Objects.entries(StudioShortcutManager.Contexts).forEach(([key, {factory}]) =>
                            contexts[key] = ShortcutDefinitions.copy(factory))
                        updateNotifier.notify()
                    }
                },
                {text: "Cancel", onClick: () => abortController.abort()}
            ]
        })).then(() => {
            if (!abortController.signal.aborted) {
                Objects.entries(StudioShortcutManager.Contexts).forEach(([key, {workingDefinition}]) =>
                    ShortcutDefinitions.copyInto(contexts[key], workingDefinition))
                StudioShortcutManager.store()
            }
        })
        lifecycle.terminate()
    }
}