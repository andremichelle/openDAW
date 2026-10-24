import css from "./AudioUnitTracks.sass?inline"
import {Lifecycle, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitBoxAdapter} from "@opendaw/studio-adapters"
import {Project} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "AudioUnitTracks")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    adapter: AudioUnitBoxAdapter
}

export const AudioUnitTracks = ({lifecycle, project, adapter}: Construct) => {
    const isBus = adapter.type === AudioUnitType.Bus
    const isAux = adapter.type === AudioUnitType.Aux
    const isOutput = adapter.type === AudioUnitType.Output
    const element: HTMLElement = (<div className={Html.buildClassList(className,
        isAux && "aux", isBus && "bus", isOutput && "output")} data-drag data-unit={UUID.toString(adapter.uuid)}/>)
    const audioUnitEditing = project.userEditingManager.audioUnit
    const refreshSelection = () => element.classList.toggle("editing", project.trackSelection.isHighlighted(adapter.box))
    lifecycle.ownAll(
        project.trackSelection.value.catchupAndSubscribe(refreshSelection),
        audioUnitEditing.catchupAndSubscribe(refreshSelection)
    )
    return element
}