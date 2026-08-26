import {Box} from "@opendaw/lib-box"
import {MenuItem, StudioPreferences} from "@opendaw/studio-core"
import {Dialogs} from "@/ui/components/dialogs.tsx"

export namespace DebugMenus {
    export const debugBox = (box: Box, separatorBefore: boolean = true) =>
        MenuItem.default({
            label: "Debug Box",
            separatorBefore,
            hidden: !StudioPreferences.settings.debug["enable-debug-menu"]
        }).setTriggerProcedure(() => Dialogs.debugBox(box))
}