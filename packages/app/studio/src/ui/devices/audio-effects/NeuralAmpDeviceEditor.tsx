import css from "./NeuralAmpDeviceEditor.sass?inline"
import {DeviceHost, NeuralAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {DefaultObservableValue, isDefined, Lifecycle, Nullable, Optional} from "@opendaw/lib-std"
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
import {MenuButton} from "@/ui/components/MenuButton"
import {MenuItem} from "@opendaw/studio-core"
import {NamLocal} from "@/ui/devices/audio-effects/NeuralAmp/NamLocal"
import {NamTone3000, PackMeta, readPackMetaFromId} from "@/ui/devices/audio-effects/NeuralAmp/NamTone3000"
import {NeuralAmpModelBox} from "@opendaw/studio-boxes"

const className = Html.adoptStyleSheet(css, "NeuralAmpDeviceEditor")

const SizeOrder: ReadonlyArray<string> = ["standard", "lite", "feather", "nano", "custom"]

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
    const packMeta = new DefaultObservableValue<Nullable<PackMeta>>(null)
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
    const updatePackMeta = () => {
        const target = adapter.box.model.targetVertex
        if (target.isEmpty()) {
            packMeta.setValue(null)
            return
        }
        const modelBox = target.unwrap().box as NeuralAmpModelBox
        const packId = modelBox.packId.getValue()
        if (packId.length === 0) {
            packMeta.setValue(null)
            return
        }
        readPackMetaFromId(packId).then(meta => packMeta.setValue(meta))
    }
    lifecycle.own(model)
    lifecycle.own(packMeta)
    lifecycle.own(adapter.modelField.subscribe(() => {
        updateModel()
        updatePackMeta()
    }))
    updateModel()
    updatePackMeta()
    const browseApi = NamTone3000.browse(boxGraph, editing, adapter)
    const browseLocal = NamLocal.browse(boxGraph, editing, adapter)
    const showModelInfo = () => {
        const current = model.getValue()
        if (isDefined(current)) {showNamModelDialog(current)}
    }
    const getCurrentModelId = (): Optional<number> => {
        const meta = packMeta.getValue()
        if (!isDefined(meta)) {return undefined}
        const target = adapter.box.model.targetVertex
        if (target.isEmpty()) {return undefined}
        const modelBox = target.unwrap().box as NeuralAmpModelBox
        const label = modelBox.label.getValue()
        const entry = meta.models.find(entry => label.endsWith(entry.name))
        return entry?.id
    }
    const getSortedModels = (meta: PackMeta): PackMeta["models"][number][] => {
        return [...meta.models].sort((entryA, entryB) => {
            const sizeA = SizeOrder.indexOf(entryA.size)
            const sizeB = SizeOrder.indexOf(entryB.size)
            if (sizeA !== sizeB) {return sizeA - sizeB}
            return entryA.name.localeCompare(entryB.name)
        })
    }
    const switchModel = (entry: PackMeta["models"][number]) => {
        const meta = packMeta.getValue()
        if (!isDefined(meta)) {return}
        NamTone3000.loadModelFromPack(
            meta.toneId.toString(), entry.id, entry.name,
            boxGraph, editing, adapter, meta.title
        )
    }
    const canStep = (direction: -1 | 1): boolean => {
        const meta = packMeta.getValue()
        if (!isDefined(meta)) {return false}
        const sorted = getSortedModels(meta)
        if (sorted.length === 0) {return false}
        const currentId = getCurrentModelId()
        if (!isDefined(currentId)) {return true}
        const currentIndex = sorted.findIndex(entry => entry.id === currentId)
        if (currentIndex === -1) {return true}
        return direction === -1 ? currentIndex > 0 : currentIndex < sorted.length - 1
    }
    const stepModel = (direction: -1 | 1) => {
        const meta = packMeta.getValue()
        if (!isDefined(meta)) {return}
        const sorted = getSortedModels(meta)
        if (sorted.length === 0) {return}
        const currentId = getCurrentModelId()
        const currentIndex = isDefined(currentId) ? sorted.findIndex(entry => entry.id === currentId) : -1
        let nextIndex: number
        if (currentIndex === -1) {
            nextIndex = direction === 1 ? 0 : sorted.length - 1
        } else {
            nextIndex = currentIndex + direction
            if (nextIndex < 0 || nextIndex >= sorted.length) {return}
        }
        switchModel(sorted[nextIndex])
    }
    const modelMenuRoot = MenuItem.root().setRuntimeChildrenProcedure(parent => {
        const meta = packMeta.getValue()
        if (!isDefined(meta)) {
            parent.addMenuItem(MenuItem.default({label: "No pack available", selectable: false}))
            return
        }
        const currentId = getCurrentModelId()
        const sorted = getSortedModels(meta)
        let lastSize = ""
        for (const entry of sorted) {
            const item = MenuItem.default({
                label: entry.name,
                checked: entry.id === currentId,
                separatorBefore: entry.size !== lastSize && lastSize !== ""
            }).setTriggerProcedure(() => switchModel(entry))
            parent.addMenuItem(item)
            lastSize = entry.size
        }
    })
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
                              <div className="browse-row">
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
                                      <img src="images/tone3000.svg" alt="tone3000 logo"/>
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
                                  <div className="pack-label">
                                      <span className="pack-header">Tone3000 Pack</span>
                                      <span className="pack-name" onInit={(element: HTMLSpanElement) => {
                                          lifecycle.own(packMeta.catchupAndSubscribe(observable => {
                                              const meta = observable.getValue()
                                              element.textContent = isDefined(meta) ? meta.title : "N/A"
                                              element.classList.toggle("empty", !isDefined(meta))
                                          }))
                                      }}/>
                                  </div>
                              </div>
                              <div className="model-row">
                                  <MenuButton root={modelMenuRoot}
                                              appearance={{
                                                  framed: true,
                                                  color: Colors.shadow,
                                                  activeColor: Colors.white
                                              }}
                                              stretch={true}>
                                      <span className="model-label" onInit={(element: HTMLSpanElement) => {
                                          lifecycle.own(model.catchupAndSubscribe(observable => {
                                              const current = observable.getValue()
                                              if (isDefined(current)) {
                                                  element.textContent = current.metadata?.name ?? "Unknown Model"
                                              } else {
                                                  element.textContent = "No model loaded"
                                                  element.classList.toggle("empty", true)
                                              }
                                          }))
                                      }}/>
                                  </MenuButton>
                                  <div className="step-arrows" onInit={(container: HTMLDivElement) => {
                                      const prevBtn: HTMLButtonElement = <button className="step-arrow" onclick={() => stepModel(-1)}>&#9650;</button>
                                      const nextBtn: HTMLButtonElement = <button className="step-arrow" onclick={() => stepModel(1)}>&#9660;</button>
                                      container.append(prevBtn, nextBtn)
                                      const updateArrows = () => {
                                          prevBtn.classList.toggle("disabled", !canStep(-1))
                                          nextBtn.classList.toggle("disabled", !canStep(1))
                                      }
                                      lifecycle.own(model.subscribe(updateArrows))
                                      lifecycle.own(packMeta.subscribe(updateArrows))
                                      queueMicrotask(updateArrows)
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
                      icon={IconSymbol.Tone3000}/>
    )
}
