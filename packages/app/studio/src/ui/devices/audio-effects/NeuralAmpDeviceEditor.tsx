import css from "./NeuralAmpDeviceEditor.sass?inline"
import {DeviceHost, NeuralAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {isDefined, Lifecycle, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Files, Html} from "@opendaw/lib-dom"
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
import {NeuralAmpModelBox} from "@opendaw/studio-boxes"

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
    let modelNameEl: HTMLSpanElement
    let currentModel: NamModel | null = null
    const updateModelName = () => {
        const modelJson = adapter.getModelJson()
        if (modelJson.length === 0) {
            modelNameEl.textContent = "No model loaded"
            modelNameEl.className = "name empty"
            currentModel = null
        } else {
            try {
                currentModel = NamModel.parse(modelJson)
                modelNameEl.textContent = currentModel.metadata?.name ?? "Unknown Model"
                modelNameEl.className = "name"
            } catch {
                modelNameEl.textContent = "Invalid model"
                modelNameEl.className = "name error"
                currentModel = null
            }
        }
    }
    const browseModel = async () => {
        try {
            const files = await Files.open({
                types: [{description: "NAM Model", accept: {"application/json": [".nam"]}}],
                multiple: false
            })
            if (files.length > 0) {
                const file = files[0]
                const text = await file.text()
                const jsonBuffer = new TextEncoder().encode(text)
                const uuid = await UUID.sha256(jsonBuffer.buffer as ArrayBuffer)
                editing.modify(() => {
                    const modelBox = boxGraph.findBox<NeuralAmpModelBox>(uuid).unwrapOrElse(() =>
                        NeuralAmpModelBox.create(boxGraph, uuid, box => {
                            box.label.setValue(file.name.replace(/\.nam$/i, ""))
                            box.model.setValue(text)
                        }))
                    adapter.box.model.refer(modelBox)
                })
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {return}
            console.error("Failed to load NAM model:", error)
        }
    }
    const showModelInfo = () => {
        if (isDefined(currentModel)) {
            showNamModelDialog(currentModel)
        }
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
                                          onClick={browseModel}
                                          appearance={{
                                              framed: true,
                                              cursor: "pointer",
                                              color: Colors.blue,
                                              activeColor: Colors.white
                                          }}
                                          className="browse-button">
                                      <Icon symbol={IconSymbol.Browse}/>
                                      <span className="name empty"
                                            onInit={(element: HTMLSpanElement) => {
                                                modelNameEl = element
                                                updateModelName()
                                                lifecycle.own(adapter.modelField.subscribe(() => updateModelName()))
                                            }}/>
                                  </Button>
                                  <Button lifecycle={lifecycle}
                                          onClick={showModelInfo}
                                          appearance={{
                                              framed: true,
                                              cursor: "pointer",
                                              color: Colors.shadow,
                                              activeColor: Colors.white
                                          }}
                                          className="icon-button">
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
