import css from "./UndoRedoButtons.sass?inline"
import {Events, Html} from "@opendaw/lib-dom"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement, DomElement} from "@opendaw/lib-jsx"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"

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
            runtime.ownAll(
                editing.subscribe(updateState),
                Events.subscribe(undoButton, "click", () => editing.undo()),
                Events.subscribe(redoButton, "click", () => editing.redo())
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