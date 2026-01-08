import {Box} from "@opendaw/lib-box"
import {MenuItem} from "@opendaw/studio-core"
import {Dialogs} from "@/ui/components/dialogs.tsx"

export namespace DebugMenus {
    export const debugBox = (box: Box, separatorBefore: boolean = true) =>
        MenuItem.default({label: "Debug Box", separatorBefore}).setTriggerProcedure(() => Dialogs.debugBox(box))
}