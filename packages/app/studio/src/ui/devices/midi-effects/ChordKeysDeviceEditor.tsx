import css from "./ChordKeysDeviceEditor.sass?inline"
import {AutomatableParameterFieldAdapter, ChordKeysDeviceBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {int, isInstanceOf, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {CanvasPainter, EffectFactories} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DeviceMidiMeter} from "@/ui/devices/panel/DeviceMidiMeter.tsx"
import {StudioService} from "@/service/StudioService"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {DropDown} from "@/ui/composite/DropDown"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {ChordKeysKeyboard} from "@/ui/devices/midi-effects/ChordKeys/ChordKeysKeyboard"

const className = Html.adoptStyleSheet(css, "ChordKeysDeviceEditor")

const Octaves: int = 3
const Degrees: ReadonlyArray<int> = [1, 2, 3, 4, 5, 6, 7]

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ChordKeysDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const ChordKeysDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {root, scale, follow, voiceLeading} = adapter.namedParameter
    const {project} = service
    const {editing, midiLearning, liveStreamReceiver, engine, timelineBoxAdapter: {keyTrack}} = project
    const tracks = deviceHost.audioUnitBoxAdapter().tracks
    const currentKey = (): Harmony.Key => follow.getValue() ? keyTrack.keyAt(engine.position.getValue()) : adapter.key
    let sounding: ReadonlyArray<int> = []
    let degree: int = 0
    let helperMask: int = 0
    let outputLow: int = 48
    const chordName: HTMLElement = <div className="chord-name"/>
    const degreeNames: ReadonlyArray<HTMLElement> = Degrees.map(() => <span/>)
    const fullNames: Array<string> = Degrees.map(() => "")
    const degreeCells: ReadonlyArray<HTMLElement> = degreeNames.map((name, index) => (
        <div><span className="number">{String(index + 1)}</span>{name}</div>
    ))
    const output: HTMLCanvasElement = <canvas/>
    const painter = lifecycle.own(new CanvasPainter(output, ({context}) =>
        ChordKeysKeyboard.draw(context, output.width, output.height, outputLow, Octaves, pitch => sounding.includes(pitch), () => "")))
    const select = (parameter: AutomatableParameterFieldAdapter<int>, names: ReadonlyArray<string>, wide: boolean) => (
        <div className={Html.buildClassList("parameter", "select", wide && "wide")}>
            <div className="name">{parameter.name}</div>
            <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                               tracks={tracks} parameter={parameter}>
                <DropDown lifecycle={lifecycle} owner={EditWrapper.forAutomatableParameter(editing, parameter)}
                          provider={() => names.map((_, index) => index)} mapping={index => names[index]}/>
            </AutomationControl>
        </div>
    )
    const toggle = (parameter: AutomatableParameterFieldAdapter<boolean>) => {
        const checkbox: HTMLElement = (
            <Checkbox lifecycle={lifecycle} model={EditWrapper.forAutomatableParameter(editing, parameter)}
                      className="toggle" appearance={{color: Colors.shadow, activeColor: Colors.green, cursor: "pointer"}}>
                <Icon symbol={IconSymbol.Checkbox}/>
            </Checkbox>
        )
        return (
            <div className="parameter switch" onclick={(event: MouseEvent) => {
                if (isInstanceOf(event.target, Node) && checkbox.contains(event.target)) {return}
                editing.modify(() => parameter.setValue(!parameter.getValue()))
            }}>
                <div className="name">{parameter.name}</div>
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={tracks} parameter={parameter}>
                    {checkbox}
                </AutomationControl>
            </div>
        )
    }
    const rootControl = select(root, MidiKeys.Names.English, false)
    const scaleControl = select(scale, MidiKeys.StockScales.map(({name}) => name), true)
    const updateChord = () => {
        const key = currentKey()
        const playing = sounding.length > 0 && degree > 0
        if (playing) {
            chordName.textContent = ChordKeysDeviceBoxAdapter.nameOf(key, degree, helperMask, Math.min(...sounding))
        }
        chordName.classList.toggle("sounding", playing)
        degreeCells.forEach((cell, index) => cell.classList.toggle("active", playing && index + 1 === degree))
        painter.requestUpdate()
    }
    const updateKey = () => {
        const key = currentKey()
        degreeNames.forEach((name, index) => {
            fullNames[index] = ChordKeysDeviceBoxAdapter.chordOf(key, index + 1, 0).mapOr(chord => Harmony.chordName(chord), "")
            name.textContent = fullNames[index].replace("aug", "+").replace("dim", "°")
        })
        if (sounding.length === 0) {chordName.textContent = fullNames[0]}
        rootControl.classList.toggle("disabled", follow.getValue())
        scaleControl.classList.toggle("disabled", follow.getValue())
        updateChord()
    }
    let lastKeyName = ""
    lifecycle.ownAll(
        liveStreamReceiver.subscribeIntegers(adapter.address.append(0), array => {
            const pitches: Array<int> = []
            for (let word = 0; word < 4; word++) {
                for (let bit = 0; bit < 32; bit++) {
                    if ((array[2 + word] & (1 << bit)) !== 0) {pitches.push(word * 32 + bit)}
                }
            }
            if (pitches.length === sounding.length && pitches.every((pitch, index) => pitch === sounding[index])
                && degree === array[0] && helperMask === array[1]) {return}
            sounding = pitches
            degree = array[0]
            helperMask = array[1]
            if (sounding.length > 0) {
                const lowest = Math.min(...sounding)
                const highest = Math.max(...sounding)
                if (lowest < outputLow || highest >= outputLow + Octaves * 12) {
                    outputLow = Math.min(Math.max(lowest - lowest % 12, 0), 128 - Octaves * 12)
                }
            }
            updateChord()
        }),
        root.subscribe(updateKey),
        scale.subscribe(updateKey),
        follow.subscribe(updateKey),
        keyTrack.subscribe(updateKey),
        engine.position.subscribe(() => {
            if (!follow.getValue()) {return}
            const name = Harmony.keyName(currentKey())
            if (name === lastKeyName) {return}
            lastKeyName = name
            updateKey()
        }),
        ...degreeCells.map((cell, index) => TextTooltip.default(cell, () => fullNames[index]))
    )
    updateKey()
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {rootControl}
                              {scaleControl}
                              {toggle(follow)}
                              {toggle(voiceLeading)}
                              <div className="keys">
                                  {chordName}
                                  {output}
                              </div>
                              <div className="degrees">{degreeCells}</div>
                              <div className="hint">White keys play the key's chords, held black keys add 7th, 9th, sus or inversion.</div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DeviceMidiMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.MidiNamed.ChordKeys.defaultIcon}/>
    )
}
