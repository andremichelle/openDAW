import {Arrays, asDefined, clamp, int, isDefined, Option, panic, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {SurgeonDeviceBox, SurgeonPattern, SurgeonPatternFields, SurgeonSound, SurgeonSoundFields} from "@opendaw/studio-boxes"
import {Address, BooleanField, Float32Field, Int32Field, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AutomatableParameterFieldAdapter} from "../../AutomatableParameterFieldAdapter"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {SurgeonModel} from "./Surgeon/SurgeonModel"

type ParameterPointers = Pointers.Automation | Pointers.MIDIControl | Pointers.Modulation
type ParameterField = Int32Field<ParameterPointers> | Float32Field<ParameterPointers>
type PlainField = Int32Field | Float32Field

export namespace Surgeon {
    export const PatternCount = 8
    export const LaneCount = 4
    export const Off = -1
    export const StateAddress = 0xFFF
    export const Rates: ReadonlyArray<string> = ["1/8", "1/16", "1/32"]
    export const Waves: ReadonlyArray<string> = ["Sine", "Half", "Rect", "Burst"]
    export const FoldPlaces: ReadonlyArray<string> = ["Before", "After"]
    export const SinePitches: ReadonlyArray<string> = ["-1 oct", "Pitch"]
    export const LaneNames: ReadonlyArray<string> = ["A", "B", "C", "D"]
    export const Slots: ReadonlyArray<int> = [Off, 0, 1, 2, 3, 4, 5, 6, 7]
    export const SlotNames: ReadonlyArray<string> = ["Off", "1", "2", "3", "4", "5", "6", "7", "8"]

    export type Spec = {
        readonly key: int
        readonly name: string
        readonly mapping: ValueMapping<number>
        readonly strings: StringMapping<number>
        readonly choices?: ReadonlyArray<string>
    }

    const percent = StringMapping.percent({fractionDigits: 0})
    // the range is kept in semitones and shown in octaves, pitches are free
    const octaves: StringMapping<number> = {
        x: semitones => ({value: (semitones / 12.0).toFixed(2), unit: "oct"}),
        y: text => {
            const typed = parseFloat(text.replace(",", "."))
            return Number.isFinite(typed) ? {type: "explicit", value: typed * 12.0} : {type: "unknown", value: text}
        }
    }
    const number = (unit: string, fractionDigits: int) => StringMapping.numeric({unit, fractionDigits})
    const whole = (key: int, name: string, min: int, max: int): Spec =>
        ({key, name, mapping: ValueMapping.linearInteger(min, max), strings: number("", 0)})
    const choice = (key: int, name: string, choices: ReadonlyArray<string>): Spec =>
        ({key, name, mapping: ValueMapping.linearInteger(0, choices.length - 1), strings: StringMapping.indices("", choices), choices})
    const unipolar = (key: int, name: string): Spec => ({key, name, mapping: ValueMapping.unipolar(), strings: percent})
    const linear = (key: int, name: string, min: number, max: number, unit: string): Spec =>
        ({key, name, mapping: ValueMapping.linear(min, max), strings: number(unit, 2)})
    const exponential = (key: int, name: string, min: number, max: number, unit: string, fractionDigits: int): Spec =>
        ({key, name, mapping: ValueMapping.exponential(min, max), strings: number(unit, fractionDigits)})

    export const Rate = choice(1, "Rate", Rates)
    export const Pitch: ReadonlyArray<Spec> = [
        whole(3, "Seed", 0, 99_999), whole(2, "Steps", 1, 32), unipolar(4, "Mutate"),
        {key: 5, name: "Range", mapping: ValueMapping.linear(0.0, 36.0), strings: octaves},
        unipolar(6, "Density"), unipolar(7, "Tie"), unipolar(8, "Slide"), unipolar(9, "Accent")
    ]
    // per lane: steps, seed, mutate
    export const Lanes: ReadonlyArray<ReadonlyArray<Spec>> = Arrays.create(lane => [
        whole(10 + lane * 3, `${LaneNames[lane]} Steps`, 1, 32),
        whole(11 + lane * 3, `${LaneNames[lane]} Seed`, 0, 99_999),
        unipolar(12 + lane * 3, `${LaneNames[lane]} Mutate`)
    ], LaneCount)
    // in the order of `SurgeonModel.Params` and of the engine's parameters
    export const Sound: ReadonlyArray<Spec> = [
        exponential(30, "Ratio 1", 0.25, 8.0, "", 2),
        unipolar(31, "Feedback"),
        exponential(32, "Ratio 2", 0.25, 16.0, "", 2),
        linear(33, "Depth 2", 0.0, 1.5, ""),
        choice(34, "Wave", Waves),
        linear(35, "Depth", 0.0, 4.0, ""),
        linear(36, "Strike", 0.0, 8.0, ""),
        exponential(37, "Strike Dec", 0.02, 1.0, "s", 3),
        unipolar(38, "Fold"),
        choice(39, "Fold Place", FoldPlaces),
        unipolar(40, "Length"),
        unipolar(41, "Held"),
        linear(42, "Sine Gain", 0.0, 1.5, ""),
        choice(43, "Sine Pitch", SinePitches),
        linear(44, "Glide", 0.0, 0.3, "s"),
        unipolar(45, "Velocity")
    ]
    // per sound parameter: one amount per lane
    export const Amounts: ReadonlyArray<ReadonlyArray<Spec>> = Sound.map((sound, index) => Arrays.create(lane => ({
        key: 100 + index * 4 + lane, name: `${sound.name} ${LaneNames[lane]}`,
        mapping: ValueMapping.bipolar(), strings: percent
    }), LaneCount))
    export const All: ReadonlyArray<Spec> = [Rate, ...Pitch, ...Lanes.flat(), ...Sound, ...Amounts.flat()]

    export type Source = { readonly get: (key: int) => number }

    // the loops as the model reads them: sound positions between 0 and 1, switches in the middle of their slot
    export const modelOf = ({get}: Source): SurgeonModel.Pattern => ({
        rate: get(Rate.key),
        pitch: {
            steps: get(2), seed: get(3), mutate: get(4), range: get(5), density: get(6), tie: get(7), slide: get(8), accent: get(9)
        },
        lanes: Lanes.map(([steps, seed, mutate]) => ({steps: get(steps.key), seed: get(seed.key), mutate: get(mutate.key)})),
        base: Sound.map(({key, mapping, choices}, index) => isDefined(choices)
            ? SurgeonModel.unitOf(SurgeonModel.Params[index], get(key) + 0.5) : mapping.x(get(key))),
        amounts: Amounts.map(row => row.map(({key}) => get(key)))
    })

    // every value of a model pattern by its box key, in box units
    export const valuesOf = ({rate, pitch, lanes, base, amounts}: SurgeonModel.Pattern): ReadonlyArray<readonly [int, number]> => [
        [Rate.key, rate], [2, pitch.steps], [3, pitch.seed], [4, pitch.mutate], [5, pitch.range], [6, pitch.density],
        [7, pitch.tie], [8, pitch.slide], [9, pitch.accent],
        ...lanes.flatMap(({steps, seed, mutate}, lane): Array<readonly [int, number]> =>
            [[Lanes[lane][0].key, steps], [Lanes[lane][1].key, seed], [Lanes[lane][2].key, mutate]]),
        ...Sound.map(({key, mapping, choices}, index): readonly [int, number] => [key, isDefined(choices)
            ? Math.min(Math.floor(SurgeonModel.valueOf(SurgeonModel.Params[index], base[index])), choices.length - 1)
            : mapping.y(base[index])]),
        ...amounts.flatMap((row, index) => row.map((amount, lane): readonly [int, number] => [Amounts[index][lane].key, amount]))
    ]

    const Keys: ReadonlySet<int> = new Set(All.map(({key}) => key))

    export const patternField = (pattern: SurgeonPattern, key: int): PlainField =>
        Keys.has(key) ? pattern.getField(key as keyof SurgeonPatternFields) : panic(`Surgeon has no value with key ${key}`)

    export const readPattern = (pattern: SurgeonPattern): SurgeonModel.Pattern =>
        modelOf({get: key => patternField(pattern, key).getValue()})

    // call inside a transaction or while the box is created
    export const writePattern = (pattern: SurgeonPattern, model: SurgeonModel.Pattern): void =>
        valuesOf(model).forEach(([key, value]) => patternField(pattern, key).setValue(value))
}

export class SurgeonDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Surgeon

    readonly #context: BoxAdaptersContext
    readonly #box: SurgeonDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly #live: Map<int, AutomatableParameterFieldAdapter<number>>
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: SurgeonDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.#live = new Map(Surgeon.All.map(({key, name, mapping, strings}) =>
            [key, this.#parametric.createParameter<number>(SurgeonDeviceBoxAdapter.#liveField(box.live, key), mapping, strings, name)]))
        this.namedParameter = this.#wrapParameters(box)
    }

    static #liveField(sound: SurgeonSound, key: int): ParameterField {return sound.getField(key as keyof SurgeonSoundFields)}

    get box(): SurgeonDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    // two integers from the engine: the playing slot and the slot waiting for its bar (-2 when none waits)
    get state(): Address {return this.#box.address.append(Surgeon.StateAddress)}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return false}

    live(key: int): AutomatableParameterFieldAdapter<number> {
        return asDefined(this.#live.get(key), `Surgeon has no value with key ${key}`)
    }

    pattern(index: int): SurgeonPattern {return this.#box.patterns.fields()[clamp(index, 0, Surgeon.PatternCount - 1)]}

    patternField(pattern: int, key: int): PlainField {return Surgeon.patternField(this.pattern(pattern), key)}

    // the live controls as the loop model, what the display draws
    liveModel(): SurgeonModel.Pattern {return Surgeon.modelOf({get: key => this.live(key).getValue()})}

    // the live controls are the selected pattern, its stored values are only brought up to date when it is left
    patternModel(pattern: int): SurgeonModel.Pattern {
        return pattern === this.#box.pattern.getValue() ? this.liveModel() : Surgeon.readPattern(this.pattern(pattern))
    }

    // call inside a transaction
    writeLive(model: SurgeonModel.Pattern): void {
        Surgeon.valuesOf(model).forEach(([key, value]) => SurgeonDeviceBoxAdapter.#liveField(this.#box.live, key).setValue(value))
    }

    // call inside a transaction: writes only the given keys of a model into the live controls
    writeLiveKeys(model: SurgeonModel.Pattern, keys: ReadonlyArray<int>): void {
        Surgeon.valuesOf(model).filter(([key]) => keys.includes(key))
            .forEach(([key, value]) => SurgeonDeviceBoxAdapter.#liveField(this.#box.live, key).setValue(value))
    }

    // call inside a transaction
    writePattern(pattern: int, model: SurgeonModel.Pattern): void {
        if (pattern === this.#box.pattern.getValue()) {return this.writeLive(model)}
        Surgeon.writePattern(this.pattern(pattern), model)
    }

    // call inside a transaction: a pattern, or Surgeon.Off. The engine takes over at the next bar
    select(slot: int): void {
        this.#box.slot.setValue(slot)
        const left = this.#box.pattern.getValue()
        if (slot === Surgeon.Off || slot === left) {return}
        Surgeon.All.forEach(({key}) => {
            const live = SurgeonDeviceBoxAdapter.#liveField(this.#box.live, key)
            this.patternField(left, key).setValue(live.getValue())
            live.setValue(this.patternField(slot, key).getValue())
        })
        this.#box.pattern.setValue(slot)
    }

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: SurgeonDeviceBox) {
        return {
            tune: this.#parametric.createParameter(
                box.tune, ValueMapping.exponential(20.0, 2000.0), StringMapping.numeric({unit: "Hz", fractionDigits: 1}), "Tune"),
            volume: this.#parametric.createParameter(
                box.volume, ValueMapping.DefaultDecibel, StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Volume"),
            slot: this.#parametric.createParameter(
                box.slot, ValueMapping.values(Surgeon.Slots), StringMapping.values("", Surgeon.Slots, Surgeon.SlotNames), "Pattern")
        } as const
    }
}
