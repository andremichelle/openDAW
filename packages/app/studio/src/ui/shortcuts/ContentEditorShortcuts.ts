import {Key, Shortcut, ShortcutDefinitions, ShortcutValidator} from "@moises-ai/lib-dom"
import {CommonShortcuts} from "@/ui/shortcuts/CommonShortcuts"

export const ContentEditorShortcutsFactory = ShortcutValidator.validate({
    ...CommonShortcuts.Position,
    ...CommonShortcuts.Selection,
    "zoom-to-content": {
        shortcut: Shortcut.of(Key.Backslash),
        description: "Zoom to content"
    }
})

export const ContentEditorShortcuts = ShortcutDefinitions.copy(ContentEditorShortcutsFactory)