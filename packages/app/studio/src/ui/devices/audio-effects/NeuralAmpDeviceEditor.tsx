import css from "./NeuralAmpDeviceEditor.sass?inline"
import {DeviceHost, NeuralAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {DefaultObservableValue, isDefined, Lifecycle, Nullable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {StudioService} from "@/service/StudioService"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {NamModel} from "@opendaw/nam-wasm"
import {showNamModelDialog} from "./NeuralAmp/NamModelDialog"
import {createSpectrumRenderer} from "./NeuralAmp/SpectrumRenderer"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {Button} from "@/ui/components/Button"
import {NamLocal} from "@/ui/devices/audio-effects/NeuralAmp/NamLocal"
import {NamTone3000} from "@/ui/devices/audio-effects/NeuralAmp/NamTone3000"

const className = Html.adoptStyleSheet(css, "NeuralAmpDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: NeuralAmpDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const NeuralAmpDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {boxGraph, editing, midiLearning} = project
    const {inputGain, outputGain, mix} = adapter.namedParameter
    const model = new DefaultObservableValue<Nullable<NamModel>>(null)
    const updateModel = () => {
        const modelJson = adapter.getModelJson()
        if (modelJson.length === 0) {
            model.setValue(null)
        } else {
            try {
                model.setValue(NamModel.parse(modelJson))
            } catch {
                model.setValue(null)
            }
        }
    }
    lifecycle.own(model)
    lifecycle.own(adapter.modelField.subscribe(() => updateModel()))
    updateModel()
    const browseApi = NamTone3000.browse(boxGraph, editing, adapter)
    const browseLocal = NamLocal.browse(boxGraph, editing, adapter)
    const showModelInfo = () => {
        const current = model.getValue()
        if (isDefined(current)) {showNamModelDialog(current)}
    }
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <canvas className="spectrum"
                                      onInit={(canvas: HTMLCanvasElement) => {
                                          lifecycle.own(createSpectrumRenderer(
                                              canvas, adapter, project.liveStreamReceiver, project.engine.sampleRate))
                                      }}/>
                              <div className="model-row">
                                  <Button lifecycle={lifecycle}
                                          onClick={browseApi}
                                          appearance={{
                                              framed: true,
                                              landscape: false,
                                              cursor: "pointer",
                                              color: Colors.shadow,
                                              activeColor: Colors.white,
                                              tooltip: "Browse tone3000.com"
                                          }}
                                          className="tone3000-button">
                                      <img src="images/tone3000-logo.webp" alt="tone3000 logo"/>
                                  </Button>
                                  <Button lifecycle={lifecycle}
                                          onClick={browseLocal}
                                          appearance={{
                                              framed: true,
                                              cursor: "pointer",
                                              color: Colors.shadow,
                                              activeColor: Colors.white,
                                              tooltip: "Browse local hard-drive"
                                          }}>
                                      <Icon symbol={IconSymbol.Browse}/>
                                  </Button>
                                  <span onInit={(element: HTMLSpanElement) => {
                                      lifecycle.own(model.catchupAndSubscribe(observable => {
                                          const current = observable.getValue()
                                          if (isDefined(current)) {
                                              element.textContent = current.metadata?.name ?? "Unknown Model"
                                              element.className = "name"
                                          } else {
                                              element.textContent = "No model loaded"
                                              element.className = "name empty"
                                          }
                                      }))
                                  }}/>
                                  <Button lifecycle={lifecycle}
                                          onClick={showModelInfo}
                                          onInit={(element: HTMLElement) => {
                                              const updateColor = () => {
                                                  element.parentElement!.style.setProperty("--color",
                                                      isDefined(model.getValue())
                                                          ? Colors.blue.toString()
                                                          : Colors.shadow.toString())
                                              }
                                              lifecycle.own(model.subscribe(() => updateColor()))
                                              queueMicrotask(updateColor)
                                          }}
                                          appearance={{
                                              framed: true,
                                              cursor: "pointer",
                                              color: Colors.shadow,
                                              activeColor: Colors.white
                                          }}>
                                      <Icon symbol={IconSymbol.Info}/>
                                  </Button>
                              </div>
                              <div className="controls-row">
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: inputGain,
                                      anchor: 0.5
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: mix,
                                      anchor: 1.0
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: outputGain,
                                      anchor: 0.5
                                  })}
                                  <Checkbox lifecycle={lifecycle}
                                            model={EditWrapper.forValue(editing, adapter.monoField)}
                                            className="mono-checkbox"
                                            appearance={{cursor: "pointer"}}>
                                      <Icon symbol={IconSymbol.Checkbox}/><span>Mono</span>
                                  </Checkbox>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={IconSymbol.NeuralAmp}/>
    )
}
