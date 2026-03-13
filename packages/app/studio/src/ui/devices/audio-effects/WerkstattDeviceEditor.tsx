import css from "./WerkstattDeviceEditor.sass?inline"
import defaultCode from "./werkstatt-default.txt?raw"
import {DeviceHost, WerkstattDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {asInstanceOf, EmptyExec, Lifecycle, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {WerkstattCompiler} from "./WerkstattCompiler"
import {WerkstattParameterBox} from "@opendaw/studio-boxes"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {Button} from "@/ui/components/Button"

const className = Html.adoptStyleSheet(css, "WerkstattDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: WerkstattDeviceBoxAdapter
    deviceHost: DeviceHost
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
    const knobs: HTMLElement = (<div className="knobs"/>)
    const set = UUID.newSet<{ uuid: UUID.Bytes, lifecycle: Terminable }>(({uuid}) => uuid)
    lifecycle.own(
        box.parameters.pointerHub.catchupAndSubscribe({
            onAdded: ({box: paramBox}) => {
                const werkstattParam = asInstanceOf(paramBox, WerkstattParameterBox)
                const parameter = adapter.parameters.parameterAt(werkstattParam.value.address)
                const terminator = new Terminator()
                const element: HTMLElement = ControlBuilder.createKnob({
                    lifecycle: terminator,
                    editing,
                    midiLearning,
                    adapter,
                    parameter
                })
                element.style.order = String(werkstattParam.index.getValue())
                terminator.own(werkstattParam.index.catchupAndSubscribe(owner =>
                    element.style.order = String(owner.getValue())))
                knobs.appendChild(element)
                set.add({uuid: paramBox.address.uuid, lifecycle: terminator})
                terminator.own({terminate: () => element.remove()})
            },
            onRemoved: ({box: {address: {uuid}}}) =>
                set.removeByKey(uuid).lifecycle.terminate()
        })
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {knobs}
                              <Button lifecycle={lifecycle}
                                      onClick={openEditor}
                                      appearance={{framed: true}}
                                      style={{
                                          fontSize: "10px",
                                          height: "min-content",
                                          marginTop: "2em"
                                      }}>Editor</Button>
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
