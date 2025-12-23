import {Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Dialogs} from "@/ui/components/dialogs"
import {PreferencePanel} from "@/ui/PreferencePanel"

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
}