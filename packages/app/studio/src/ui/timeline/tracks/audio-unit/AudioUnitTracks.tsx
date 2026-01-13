import css from "./AudioUnitTracks.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {Vertex} from "@moises-ai/lib-box"
import {Html} from "@moises-ai/lib-dom"
import {AudioUnitType} from "@moises-ai/studio-enums"
import {AudioUnitBoxAdapter, Devices} from "@moises-ai/studio-adapters"
import {Project} from "@moises-ai/studio-core"

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
        isAux && "aux", isBus && "bus", isOutput && "output")}/>)
    const audioUnitEditing = project.userEditingManager.audioUnit
    lifecycle.ownAll(
        adapter.indexField.catchupAndSubscribe(field => element.style.gridRow = `${field.getValue() + 1}`),
        audioUnitEditing.catchupAndSubscribe(optVertex => optVertex.match({
            none: () => element.classList.remove("editing"),
            some: (vertex: Vertex) => {
                const editing = project.boxAdapters.adapterFor(vertex.box, Devices.isHost).audioUnitBoxAdapter()
                element.classList.toggle("editing", editing === adapter)
            }
        }))
    )
    return element
}