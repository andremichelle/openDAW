import {Lifecycle, UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter} from "@opendaw/studio-adapters"
import {createElement} from "@opendaw/lib-jsx"
import {Project} from "@opendaw/studio-core"
import {BusOutputSelector} from "./BusOutputSelector"

type Construct = {
    lifecycle: Lifecycle
    project: Project
    adapter: AudioUnitBoxAdapter
}

export const ChannelOutputSelector = ({lifecycle, project, adapter}: Construct) => (
    <BusOutputSelector lifecycle={lifecycle}
                       project={project}
                       output={adapter.output}
                       pointer={adapter.box.output}
                       selectable={bus => {
                           const inputUUID = adapter.input.adapter().unwrapOrNull()?.uuid ?? UUID.Lowest
                           return UUID.Comparator(bus.uuid, inputUUID) !== 0
                       }}/>
)