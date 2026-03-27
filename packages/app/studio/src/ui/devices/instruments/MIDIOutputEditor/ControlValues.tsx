import css from "./ControlValues.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {asInstanceOf, byte, Lifecycle, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {createElement, Group} from "@opendaw/lib-jsx"
import {AutomatableParameterFieldAdapter, MIDIOutputDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {MIDIOutputParameterBox} from "@opendaw/studio-boxes"
import {Project} from "@opendaw/studio-core"
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
                                          tracks={adapter.deviceHost().audioUnitBoxAdapter().tracks}
                                          box={parameterBox}
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