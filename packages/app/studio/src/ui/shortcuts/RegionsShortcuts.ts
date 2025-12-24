import {ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"
import {CommonShortcuts} from "@/ui/shortcuts/CommonShortcuts"

export const RegionsShortcutsFactory = ShortcutValidator.validate({
    ...CommonShortcuts.Selection
})

export const RegionsShortcuts = ShortcutDefinitions.copy(RegionsShortcutsFactory)