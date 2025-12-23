import {Notifier, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Dialogs} from "@/ui/components/dialogs"
import {PreferencePanel} from "@/ui/PreferencePanel"
import {ShortcutManagerView} from "@/ui/components/ShortcutManagerView"
import {GlobalShortcuts, GlobalShortcutsFactory} from "@/shortcuts/GlobalShortcuts"
import {ShortcutDefinitions} from "@/shortcuts/ShortcutDefinitions"
import {StudioShortcutManager} from "@/service/StudioShortcutManager"

export namespace StudioDialogs {
    export const showPreferences = async () => {
        const lifecycle = new Terminator()
        await Promises.tryCatch(Dialogs.show({
            headline: "Preferences",
            content: PreferencePanel({lifecycle}),
            growWidth: true
        }))
        lifecycle.terminate()
    }

    export const showShortcutManager = async () => {
        const lifecycle = new Terminator()
        const abortController = new AbortController()
        const updateNotifier = new Notifier<void>()
        const contexts = {
            "Global": ShortcutDefinitions.copy(GlobalShortcuts)
        } satisfies Record<string, ShortcutDefinitions>
        await Promises.tryCatch(Dialogs.show({
            headline: "Shortcut Manager",
            content: ShortcutManagerView({lifecycle, contexts, updateNotifier}),
            growWidth: true,
            abortSignal: abortController.signal,
            buttons: [
                {
                    text: "Reset", onClick: () => {
                        contexts["Global"] = ShortcutDefinitions.copy(GlobalShortcutsFactory)
                        updateNotifier.notify()
                    }
                },
                {text: "Cancel", onClick: () => abortController.abort()}
            ]
        })).then(() => {
            if (!abortController.signal.aborted) {
                ShortcutDefinitions.copyInto(contexts.Global, GlobalShortcuts)
                StudioShortcutManager.store()
            }
        })
        lifecycle.terminate()
    }
}