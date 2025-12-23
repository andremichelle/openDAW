import {Notifier, Objects, Strings, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Dialogs} from "@/ui/components/dialogs"
import {PreferencePanel} from "@/ui/PreferencePanel"
import {ShortcutManagerView} from "@/ui/components/ShortcutManagerView"
import {StudioShortcutManager} from "@/service/StudioShortcutManager"
import {ShortcutDefinitions} from "@opendaw/lib-dom"

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

        const contexts: Record<string, ShortcutDefinitions> = {}
        Objects.entries(StudioShortcutManager.Contexts).forEach(([name, shortcuts]) =>
            contexts[Strings.hyphenToCamelCase(name)] = ShortcutDefinitions.copy(shortcuts.user))

        await Promises.tryCatch(Dialogs.show({
            headline: "Shortcut Manager",
            content: ShortcutManagerView({lifecycle, contexts, updateNotifier}),
            growWidth: true,
            abortSignal: abortController.signal,
            buttons: [
                {
                    text: "Reset", onClick: () => {
                        Objects.entries(StudioShortcutManager.Contexts).forEach(([name, {factory}]) =>
                            contexts[Strings.hyphenToCamelCase(name)] = ShortcutDefinitions.copy(factory))
                        updateNotifier.notify()
                    }
                },
                {text: "Cancel", onClick: () => abortController.abort()}
            ]
        })).then(() => {
            if (!abortController.signal.aborted) {
                Objects.entries(StudioShortcutManager.Contexts).forEach(([name, {user}]) =>
                    ShortcutDefinitions.copyInto(contexts[Strings.hyphenToCamelCase(name)], user))
                StudioShortcutManager.store()
            }
        })
        lifecycle.terminate()
    }
}