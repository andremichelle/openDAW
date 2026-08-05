import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@opendaw/lib-dom"
import {CommonShortcuts} from "@/ui/shortcuts/CommonShortcuts"

export const ContentEditorShortcutsFactory = ShortcutValidator.validate({
    ...CommonShortcuts.Position,
    ...CommonShortcuts.Selection,
    ...CommonShortcuts.Snapping,
    "zoom-to-loop-duration": {
        shortcut: Shortcut.of(Key.Backslash),
        description: "Zoom to loop duration"
    }
})

export const ContentEditorShortcuts = ShortcutDefinitions.copy(ContentEditorShortcutsFactory)