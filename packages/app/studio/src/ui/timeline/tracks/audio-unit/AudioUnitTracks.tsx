import css from "./AudioUnitTracks.sass?inline"
import {Lifecycle, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitBoxAdapter} from "@opendaw/studio-adapters"
import {Project} from "@opendaw/studio-core"
import {TrackGrouping} from "./TrackGrouping"

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
        isAux && "aux", isBus && "bus", isOutput && "output")} data-drag data-unit={UUID.toString(adapter.uuid)}>
        <div className="unit-line"/>
    </div>)
    const audioUnitEditing = project.userEditingManager.audioUnit
    const refreshSelection = () => {
        element.classList.toggle("selected", project.audioUnitSelection.isSelected(adapter.box))
        element.classList.toggle("line-active", TrackGrouping.isTrackLineActive(project, adapter.box))
    }
    lifecycle.ownAll(
        project.audioUnitSelection.catchupAndSubscribe({onSelected: refreshSelection, onDeselected: refreshSelection}),
        audioUnitEditing.catchupAndSubscribe(refreshSelection),
        project.audioUnitLayout.value.subscribe(refreshSelection)
    )
    return element
}