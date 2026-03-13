import css from "./WerkstattDeviceEditor.sass?inline"
import defaultCode from "./werkstatt-default.txt?raw"
import {AutomatableParameterFieldAdapter, DeviceHost, WerkstattDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {asInstanceOf, EmptyExec, int, Lifecycle, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {createElement, Group} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {WerkstattCompiler} from "./WerkstattCompiler"
import {WerkstattParameterBox} from "@opendaw/studio-boxes"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"

const className = Html.adoptStyleSheet(css, "WerkstattDeviceEditor")

const NumColumns = 3

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: WerkstattDeviceBoxAdapter
    deviceHost: DeviceHost
}

type Control = {
    lifecycle: Lifecycle
    parameter: AutomatableParameterFieldAdapter<number>
    name: string
    grid: { u: int, v: int }
}

export const WerkstattDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const box = adapter.box
    const storedCode = box.code.getValue()
    const userCode = storedCode.length > 0 ? WerkstattCompiler.stripHeader(storedCode) : defaultCode
    const compile = async (code: string) => {
        return WerkstattCompiler.compile(service.audioContext, box, code)
    }
    compile(userCode).finally(EmptyExec)
    const openEditor = () => service.openWerkstattEditor({
        handler: {
            name: adapter.labelField.getValue(),
            compile,
            subscribeErrors: observer =>
                service.engine.subscribeDeviceMessage(UUID.toString(adapter.uuid), observer)
        },
        initialCode: WerkstattCompiler.stripHeader(box.code.getValue()) || defaultCode,
        previousScreen: service.layout.screen.getValue()
    })
    const createControl = ({lifecycle: controlLifecycle, parameter, name, grid: {u, v}}: Control) => (
        <div className="control" style={{gridArea: `${v + 1} / ${u + 1} / ${v + 3} / ${u + 2}`}}>
            <h3>{name}</h3>
            <RelativeUnitValueDragging lifecycle={controlLifecycle}
                                       editing={editing}
                                       parameter={parameter}
                                       supressValueFlyout={true}>
                <ParameterLabel lifecycle={controlLifecycle}
                                editing={editing}
                                midiLearning={midiLearning}
                                adapter={adapter}
                                parameter={parameter}
                                classList={["center"]}
                                framed={true} standalone/>
            </RelativeUnitValueDragging>
        </div>
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <Group onInit={parent => {
                                  const set = UUID.newSet<{
                                      uuid: UUID.Bytes,
                                      lifecycle: Terminable
                                  }>(({uuid}) => uuid)
                                  lifecycle.own(
                                      box.parameters.pointerHub.catchupAndSubscribe({
                                          onAdded: ({box: paramBox}) => {
                                              const werkstattParam = asInstanceOf(paramBox, WerkstattParameterBox)
                                              const parameter: AutomatableParameterFieldAdapter<number> =
                                                  adapter.parameters.parameterAt(werkstattParam.value.address)
                                              const terminator = new Terminator()
                                              const index = werkstattParam.index.getValue()
                                              const element = createControl({
                                                  lifecycle: terminator,
                                                  parameter,
                                                  name: werkstattParam.label.getValue(),
                                                  grid: {u: index % NumColumns, v: Math.floor(index / NumColumns) * 2}
                                              })
                                              parent.appendChild(element)
                                              set.add({uuid: paramBox.address.uuid, lifecycle: terminator})
                                              terminator.own({terminate: () => element.remove()})
                                          },
                                          onRemoved: ({box: {address: {uuid}}}) =>
                                              set.removeByKey(uuid).lifecycle.terminate()
                                      })
                                  )
                              }}/>
                              <button className="edit" onclick={openEditor}>Edit</button>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Werkstatt.defaultIcon}/>
    )
}
