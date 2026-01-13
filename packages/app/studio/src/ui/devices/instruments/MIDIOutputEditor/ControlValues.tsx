import css from "./ControlValues.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {asInstanceOf, byte, Lifecycle, Terminable, Terminator, UUID} from "@moises-ai/lib-std"
import {createElement, Group} from "@moises-ai/lib-jsx"
import {AutomatableParameterFieldAdapter, MIDIOutputDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {MIDIOutputParameterBox} from "@moises-ai/studio-boxes"
import {Project} from "@moises-ai/studio-core"
import {ControlValue} from "@/ui/devices/instruments/MIDIOutputEditor/ControlValue"

const className = Html.adoptStyleSheet(css, "ControlValues")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    adapter: MIDIOutputDeviceBoxAdapter
}

export const ControlValues = ({lifecycle, project, adapter}: Construct) => (
    <div className={className}>
        <Group onInit={parent => {
            const set = UUID.newSet<{
                uuid: UUID.Bytes,
                lifecycle: Terminable
            }>(({uuid}) => uuid)
            lifecycle.ownAll(
                adapter.box.parameters.pointerHub.catchupAndSubscribe({
                    onAdded: ({box}) => {
                        const parameterBox = asInstanceOf(box, MIDIOutputParameterBox)
                        const parameter: AutomatableParameterFieldAdapter<byte> =
                            adapter.parameters.parameterAt(parameterBox.value.address)
                        const lifecycle = new Terminator()
                        const element = (
                            <ControlValue lifecycle={lifecycle}
                                          project={project}
                                          box={parameterBox}
                                          adapter={adapter}
                                          parameter={parameter}/>
                        )
                        parent.appendChild(element)
                        set.add({uuid: box.address.uuid, lifecycle})
                        lifecycle.own({terminate: () => element.remove()})
                    },
                    onRemoved: ({box: {address: {uuid}}}) => set.removeByKey(uuid).lifecycle.terminate()
                })
            )
        }}/>
    </div>
)