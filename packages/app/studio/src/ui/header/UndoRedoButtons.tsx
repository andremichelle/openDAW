import css from "./UndoRedoButtons.sass?inline"
import {Events, Html} from "@moises-ai/lib-dom"
import {getOrProvide, Lifecycle, Terminator} from "@moises-ai/lib-std"
import {createElement, DomElement} from "@moises-ai/lib-jsx"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@moises-ai/studio-enums"
import {StudioService} from "@/service/StudioService"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {ShortcutTooltip} from "@/ui/shortcuts/ShortcutTooltip"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"

const className = Html.adoptStyleSheet(css, "UndoRedoButtons")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const UndoRedoButtons = ({lifecycle, service: {projectProfileService}}: Construct) => {
    const undoButton: DomElement = (<Icon symbol={IconSymbol.Undo}/>)
    const redoButton: DomElement = (<Icon symbol={IconSymbol.Redo}/>)
    const runtime = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        projectProfileService.catchupAndSubscribe(optProfile => {
            runtime.terminate()
            if (optProfile.isEmpty()) {return}
            const editing = optProfile.unwrap().project.editing
            const updateState = () => {
                undoButton.classList.toggle("enabled", editing.canUndo())
                redoButton.classList.toggle("enabled", editing.canRedo())
            }
            updateState()
            runtime.ownAll(
                editing.subscribe(updateState),
                Events.subscribe(undoButton, "click", () => editing.undo()),
                Events.subscribe(redoButton, "click", () => editing.redo()),
                TextTooltip.default(undoButton, () => getOrProvide(
                    ShortcutTooltip.create("Undo", GlobalShortcuts["project-undo"].shortcut))),
                TextTooltip.default(redoButton, () => getOrProvide(
                    ShortcutTooltip.create("Redo", GlobalShortcuts["project-redo"].shortcut)))
            )
        })
    )
    return (
        <div className={className}>
            {undoButton}
            {redoButton}
        </div>
    )
}