import css from "./KorpusDeviceEditor.sass?inline"
import {Arrays, int, Lifecycle, ValueGuide} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {AutomatableParameterFieldAdapter, DeviceHost, KorpusDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {MenuItem} from "@opendaw/studio-core"
import {MenuButton} from "@/ui/components/MenuButton"
import {AutomationControl} from "@/ui/components/AutomationControl"

const className = Html.adoptStyleSheet(css, "KorpusDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: KorpusDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const KorpusDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {
        exciter, intensity, position, vibrato, air, stroke,
        objectA, dampingA, tuneA, widthA, levelA,
        objectB, dampingB, tuneB, widthB, levelB,
        routing, couple, volume
    } = adapter.namedParameter
    const knob = (parameter: AutomatableParameterFieldAdapter, label?: string, options?: ValueGuide.Options) =>
        ControlBuilder.createKnob({
            lifecycle, editing, midiLearning, adapter, parameter, color: Colors.black, label, options
        })
    const optionLabels = (parameter: AutomatableParameterFieldAdapter<int>, count: int) =>
        Arrays.create(index => parameter.stringMapping.x(index).value, count)
    const sizerLabels = [...optionLabels(exciter, 5), ...optionLabels(objectA, 6),
        ...optionLabels(objectB, 7), ...optionLabels(routing, 2)]
    const dropdown = (parameter: AutomatableParameterFieldAdapter<int>, count: int) => {
        const label: HTMLElement = <span/>
        lifecycle.own(parameter.catchupAndSubscribe(owner => label.textContent = owner.getPrintValue().value))
        return (
            <AutomationControl lifecycle={lifecycle}
                               editing={editing}
                               midiLearning={midiLearning}
                               tracks={adapter.audioUnitBoxAdapter().tracks}
                               parameter={parameter}>
                <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    ...Arrays.create(index => MenuItem.default({
                        label: parameter.stringMapping.x(index).value, checked: index === parameter.getValue()
                    }).setTriggerProcedure(() => editing.modify(() => parameter.setValue(index))), count)))}
                            pointer>
                    <div className="value">
                        {sizerLabels.map(text => <span className="sizer">{text}</span>)}
                        {label}
                    </div>
                </MenuButton>
            </AutomationControl>
        )
    }
    const semitoneDetents: ValueGuide.Options = {trackLength: 384,
        snap: {snapLength: 8, threshold: Arrays.create(index => tuneB.valueMapping.x(index - 24), 49)}}
    const objectBKnobs: HTMLElement = (
        <div className="knobs">
            <div className="row">{knob(dampingB, "Damping")}{knob(tuneB, "Tune", semitoneDetents)}</div>
            <div className="row">{knob(widthB, "Width")}{knob(levelB, "Level")}</div>
        </div>
    )
    const routingDropdown: HTMLElement = dropdown(routing, 2)
    const coupleKnob: HTMLElement = knob(couple)
    const strokeKnob: HTMLElement = knob(stroke)
    lifecycle.own(exciter.catchupAndSubscribe(owner => {
        const value = owner.getValue()
        strokeKnob.classList.toggle("inactive", value === 1 || value === 4)
    }))
    lifecycle.own(objectB.catchupAndSubscribe(owner => {
        const bypassed = owner.getValue() === 6
        objectBKnobs.classList.toggle("inactive", bypassed)
        routingDropdown.classList.toggle("inactive", bypassed)
        coupleKnob.classList.toggle("inactive", bypassed)
    }))
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <div className={className}>
                              <section>
                                  <header><h1>Exciter</h1>{dropdown(exciter, 5)}</header>
                                  <div className="knobs">
                                      <div className="row">{knob(intensity)}{knob(air)}{strokeKnob}</div>
                                      <div className="row">{knob(position)}{knob(vibrato)}</div>
                                  </div>
                              </section>
                              <section>
                                  <header><h1>Object A</h1>{dropdown(objectA, 6)}</header>
                                  <div className="knobs">
                                      <div className="row">{knob(dampingA, "Damping")}{knob(tuneA, "Tune")}</div>
                                      <div className="row">{knob(widthA, "Width")}{knob(levelA, "Level")}</div>
                                  </div>
                              </section>
                              <section>
                                  <header><h1>Object B</h1>{dropdown(objectB, 7)}</header>
                                  {objectBKnobs}
                              </section>
                              <section>
                                  <header><h1>Out</h1>{routingDropdown}</header>
                                  <div className="knobs">
                                      <div className="row">{coupleKnob}</div>
                                      <div className="row">{knob(volume)}</div>
                                  </div>
                              </section>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={IconSymbol.DrumSet}/>
    )
}
