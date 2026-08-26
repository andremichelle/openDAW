import css from "./FrequencySplitDeviceEditor.sass?inline"
import {DeviceHost, FrequencySplitBoxAdapter} from "@opendaw/studio-adapters"
import {clamp, int, isDefined, Lifecycle, MutableObservableValue, ObservableValue, Observer, Option, Subscription, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AudioEffectCompositeCellBox} from "@opendaw/studio-boxes"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {SnapCommonDecibel} from "@/ui/configs.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {CompositeEntryList} from "@/ui/devices/CompositeEntryList"
import {AudioCompositeEntry} from "@/ui/devices/AudioCompositeEntry"
import {StudioService} from "@/service/StudioService"
import {IconSymbol} from "@opendaw/studio-enums"
import {FrequencySplitGraph, GAP} from "./FrequencySplitGraph"

const className = Html.adoptStyleSheet(css, "FrequencySplitDeviceEditor")

const BAND_LABELS: Readonly<Record<number, ReadonlyArray<string>>> = {
    2: ["Low", "High"],
    3: ["Low", "Mid", "High"],
    4: ["Low", "Low Mid", "High Mid", "High"]
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: FrequencySplitBoxAdapter
    deviceHost: DeviceHost
}

export const FrequencySplitDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const bandCount = (): int => adapter.entries.adapters().length
    const relabel = (count: int): void => {
        const labels = BAND_LABELS[count] ?? []
        adapter.entries.adapters().forEach(entry => {
            const label = labels[entry.indexField.getValue()]
            if (isDefined(label)) {entry.box.label.setValue(label)}
        })
    }
    const growTo = (from: int, to: int): void => {
        Array.from({length: to - from}, (_, step) => from + step).forEach(index => {
            const crossover = adapter.crossover[index - 1]
            const previousUnit = index > 1 ? adapter.crossover[index - 2].getUnitValue() : 0.0
            crossover.setUnitValue(clamp((previousUnit + 1.0) / 2.0, previousUnit + GAP, 1.0 - GAP))
            AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(adapter.box.entries)
                box.index.setValue(index)
            })
        })
    }
    const shrinkTo = (target: int): void => {
        adapter.entries.adapters()
            .filter(entry => entry.indexField.getValue() >= target)
            .forEach(entry => entry.box.delete())
    }
    const setBandCount = (target: int): void => {
        const clamped = clamp(Math.round(target), 2, FrequencySplitBoxAdapter.MAX_BANDS)
        const count = bandCount()
        if (clamped === count) {return}
        editing.modify(() => {
            if (clamped > count) {growTo(count, clamped)} else {shrinkTo(clamped)}
            relabel(clamped)
        })
    }
    const rows = (rowLifecycle: Lifecycle): ReadonlyArray<Element> => adapter.entries.adapters()
        .map(entry => (
            <AudioCompositeEntry lifecycle={rowLifecycle}
                                 service={service}
                                 entry={entry}
                                 fixed={adapter.entriesFixed}/>
        ))
    const bandModel: MutableObservableValue<int> = new class implements MutableObservableValue<int> {
        getValue(): int {return bandCount()}
        setValue(value: int): void {setBandCount(value)}
        subscribe(observer: Observer<ObservableValue<int>>): Subscription {
            return adapter.entries.subscribe({
                onAdd: () => observer(this), onRemove: () => observer(this), onReorder: () => observer(this)
            })
        }
        catchupAndSubscribe(observer: Observer<ObservableValue<int>>): Subscription {
            observer(this)
            return this.subscribe(observer)
        }
    }
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="main">
                                  <FrequencySplitGraph lifecycle={lifecycle} editing={editing} project={project} adapter={adapter}/>
                                  <CompositeEntryList lifecycle={lifecycle}
                                                      rows={rows}
                                                      watch={update => adapter.entries.subscribe({
                                                          onAdd: update, onRemove: update, onReorder: update
                                                      })}
                                                      footer={Option.None}/>
                              </div>
                              <div className="mix">
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter,
                                      parameter: adapter.namedParameter.dry, options: SnapCommonDecibel
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter,
                                      parameter: adapter.namedParameter.wet, options: SnapCommonDecibel
                                  })}
                                  <div className="bands">
                                      <span className="caption">Bands</span>
                                      <RadioGroup lifecycle={lifecycle}
                                                  appearance={{framed: true}}
                                                  model={bandModel}
                                                  elements={[
                                                      {value: 2, element: (<span>2</span>)},
                                                      {value: 3, element: (<span>3</span>)},
                                                      {value: 4, element: (<span>4</span>)}
                                                  ]}/>
                                  </div>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={IconSymbol.Charts}/>
    )
}
