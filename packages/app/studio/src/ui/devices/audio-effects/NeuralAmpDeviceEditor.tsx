import css from "./NeuralAmpDeviceEditor.sass?inline"
import {DeviceHost, NeuralAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Events, Files, Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {NamModel} from "@opendaw/nam-wasm"
import {showNamModelDialog} from "./NeuralAmp/NamModelDialog"

const className = Html.adoptStyleSheet(css, "NeuralAmpDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: NeuralAmpDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const NeuralAmpDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {inputGain, outputGain, mix} = adapter.namedParameter

    let modelNameEl: HTMLSpanElement

    const updateModelName = () => {
        const modelJson = adapter.modelJsonField.getValue()
        if (modelJson.length === 0) {
            modelNameEl.textContent = "No model loaded"
            modelNameEl.className = "model-name empty"
        } else {
            try {
                const model = NamModel.parse(modelJson)
                modelNameEl.textContent = model.metadata?.name ?? "Unknown Model"
                modelNameEl.className = "model-name"
            } catch {
                modelNameEl.textContent = "Invalid model"
                modelNameEl.className = "model-name error"
            }
        }
    }

    const browseModel = async () => {
        try {
            const files = await Files.open({
                types: [{
                    description: "NAM Model",
                    accept: {"application/json": [".nam"]}
                }],
                multiple: false
            })
            if (files.length > 0) {
                const file = files[0]
                const text = await file.text()
                editing.modify(() => adapter.modelJsonField.setValue(text))
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                return // User cancelled
            }
            console.error("Failed to load NAM model:", error)
        }
    }

    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="model-section">
                                  <h1 onclick={() => {
                                      const modelJson = adapter.modelJsonField.getValue()
                                      if (modelJson.length > 0) {
                                          try {
                                              const model = NamModel.parse(modelJson)
                                              showNamModelDialog(model)
                                          } catch {
                                              // Invalid model, do nothing
                                          }
                                      }
                                  }}>Model</h1>
                                  <span className="model-name empty"
                                        onInit={(element: HTMLSpanElement) => {
                                            modelNameEl = element
                                            updateModelName()
                                            lifecycle.own(adapter.modelJsonField.subscribe(() => updateModelName()))
                                        }}/>
                                  <button className="browse-button"
                                          onclick={browseModel}>
                                      Browse
                                  </button>
                              </div>
                              <div className="controls">
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: inputGain,
                                      anchor: 0.5
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: outputGain,
                                      anchor: 0.5
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: mix,
                                      anchor: 1.0
                                  })}
                              </div>
                              <div className="mono-toggle" onInit={element => {
                                  lifecycle.ownAll(
                                      adapter.monoField.catchupAndSubscribe(field =>
                                          element.classList.toggle("active", field.getValue())),
                                      Events.subscribe(element, "click", () =>
                                          editing.modify(() => adapter.monoField.setValue(!adapter.monoField.getValue())))
                                  )
                              }}>Mono</div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.NeuralAmp.defaultIcon}/>
    )
}
