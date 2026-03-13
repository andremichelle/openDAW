import css from "./WerkstattDeviceEditor.sass?inline"
import defaultCode from "./werkstatt-default.txt?raw"
import {
    AutomatableParameterFieldAdapter,
    DeviceHost,
    WerkstattDeviceBoxAdapter
} from "@opendaw/studio-adapters"
import {asInstanceOf, EmptyExec, Lifecycle, Terminable, Terminator, UUID} from "@opendaw/lib-std"
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
    const textarea = <textarea spellcheck={false}>{userCode}</textarea> as HTMLTextAreaElement
    const errorDisplay = <div className="error"/> as HTMLDivElement
    const runCode = async () => {
        errorDisplay.textContent = ""
        errorDisplay.classList.remove("visible")
        await WerkstattCompiler.compile(service.audioContext, box, textarea.value)
    }
    const runButton = <button onclick={runCode}>Run</button>
    lifecycle.ownAll(
        service.engine.subscribeDeviceMessage(UUID.toString(adapter.uuid), message => {
            errorDisplay.textContent = message
            errorDisplay.classList.add("visible")
        })
    )
    runCode().then(EmptyExec, EmptyExec)
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {textarea}
                              {errorDisplay}
                              {runButton}
                              <div className="parameters">
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
                                                  const element = (
                                                      <div className="param">
                                                          <h3>{werkstattParam.label.getValue()}</h3>
                                                          <RelativeUnitValueDragging lifecycle={terminator}
                                                                                     editing={editing}
                                                                                     parameter={parameter}>
                                                              <ParameterLabel lifecycle={terminator}
                                                                              editing={editing}
                                                                              midiLearning={midiLearning}
                                                                              adapter={adapter}
                                                                              parameter={parameter}
                                                                              framed standalone/>
                                                          </RelativeUnitValueDragging>
                                                      </div>
                                                  )
                                                  parent.appendChild(element)
                                                  set.add({uuid: paramBox.address.uuid, lifecycle: terminator})
                                                  terminator.own({terminate: () => element.remove()})
                                              },
                                              onRemoved: ({box: {address: {uuid}}}) =>
                                                  set.removeByKey(uuid).lifecycle.terminate()
                                          })
                                      )
                                  }}/>
                              </div>
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
