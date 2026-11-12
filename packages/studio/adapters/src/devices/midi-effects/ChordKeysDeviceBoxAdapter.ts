import {Pointers} from "@opendaw/studio-enums"
import {int, Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {ChordKeysDeviceBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, MidiEffectDeviceAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class ChordKeysDeviceBoxAdapter implements MidiEffectDeviceAdapter {
    static readonly WhiteKeys: ReadonlyArray<int> = [0, 2, 4, 5, 7, 9, 11]
    // WASM CONTRACT: the helper pitch classes in the order of the bits of the engine's helper mask (device-chord-keys)
    static readonly Helpers: ReadonlyArray<{ readonly pitchClass: int, readonly name: string }> = [
        {pitchClass: 1, name: "7th"}, {pitchClass: 3, name: "9th"}, {pitchClass: 6, name: "sus2"},
        {pitchClass: 8, name: "sus4"}, {pitchClass: 10, name: "inv"}
    ]

    readonly type = "midi-effect"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.ChordKeys

    readonly #context: BoxAdaptersContext
    readonly #box: ChordKeysDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: ChordKeysDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): ChordKeysDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.MIDIEffectHost> {return this.#box.host}
    get key(): Harmony.Key {
        const {root, scale} = this.namedParameter
        return {root: root.getValue(), bits: MidiKeys.StockScales.at(scale.getValue())?.bits ?? Harmony.MajorBits}
    }

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: ChordKeysDeviceBox) {
        return {
            root: this.#parametric.createParameter(
                box.root,
                ValueMapping.linearInteger(0, 11),
                StringMapping.indices("", MidiKeys.Names.English), "Root"),
            scale: this.#parametric.createParameter(
                box.scale,
                ValueMapping.linearInteger(0, MidiKeys.StockScales.length - 1),
                StringMapping.indices("", MidiKeys.StockScales.map(scale => scale.name)), "Scale"),
            follow: this.#parametric.createParameter(
                box.follow,
                ValueMapping.bool,
                StringMapping.bool, "Follow"),
            voiceLeading: this.#parametric.createParameter(
                box.voiceLeading,
                ValueMapping.bool,
                StringMapping.bool, "Voice Leading")
        } as const
    }
}

export namespace ChordKeysDeviceBoxAdapter {
    // the chord a white key plays with the given helper mask, as the engine builds it
    export const chordOf = (key: Harmony.Key, degree: int, helperMask: int, inversion: int = 0): Option<Harmony.Chord> => {
        const has = (bit: int) => (helperMask & (1 << bit)) !== 0
        const shapeOf = (name: string) => Harmony.ChordShapes.find(shape => shape.name === name)?.bits ?? 0
        const shape = has(2) ? shapeOf("Sus2") : has(3) ? shapeOf("Sus4") : 0
        return Harmony.chord(key, degree, 0, shape, has(0) ? has(1) ? 5 : 4 : 3, inversion)
    }

    // the name of what sounds: the inversion follows from the lowest sounding pitch, the 9th alone is an add9
    export const nameOf = (key: Harmony.Key, degree: int, helperMask: int, lowest: int): string => {
        const addNine = (helperMask & 0b11) === 0b10 && (helperMask & 0b1100) === 0
        const name = chordOf(key, degree, helperMask).flatMap(chord => {
            const inversion = Math.max(0, chord.stack.findIndex(interval => (chord.root + interval) % 12 === lowest % 12))
            return chordOf(key, degree, helperMask, inversion)
        }).mapOr(chord => Harmony.chordName(chord), "")
        if (!addNine) {return name}
        const slash = name.indexOf("/")
        if (slash !== -1) {return `${name.slice(0, slash)}add9${name.slice(slash)}`}
        const ninthInBass = chordOf(key, degree, 0)
            .mapOr(chord => !chord.stack.some(interval => (chord.root + interval) % 12 === lowest % 12), false)
        return ninthInBass ? `${name}add9/${MidiKeys.Names.English[lowest % 12]}` : `${name}add9`
    }

    // the step (1 to 7) a white key plays, 0 for a black key
    export const degreeOf = (pitch: int): int => ChordKeysDeviceBoxAdapter.WhiteKeys.indexOf(pitch % 12) + 1

    // WASM CONTRACT: the pitches the engine plays for a pressed white key (device-chord-keys `target`)
    export const voicing = (key: Harmony.Key, pressed: int, helperMask: int, inversion: int, shift: int): ReadonlyArray<int> => {
        const has = (bit: int) => (helperMask & (1 << bit)) !== 0
        const degree = degreeOf(pressed)
        const shapeOf = (name: string) => Harmony.ChordShapes.find(shape => shape.name === name)?.bits ?? 0
        const shape = has(2) ? shapeOf("Sus2") : has(3) ? shapeOf("Sus4") : 0
        const stacked = shape !== 0 ? Harmony.chord(key, degree, 0, shape, 3) : Harmony.chord(key, degree, 0, 0, 3)
            .map(triad => {
                const maskOf = (notes: int) => Harmony.chord(key, degree, 0, 0, notes).mapOr(chord => chord.bits, triad.bits)
                const seventh = maskOf(4), ninth = maskOf(5)
                const bits = triad.bits | (has(0) ? seventh & ~triad.bits : 0) | (has(1) ? ninth & ~seventh : 0)
                return {...triad, bits}
            })
        return stacked.mapOr(({root, bits}) => {
            const base = pressed - pressed % 12 + key.root + ((root - key.root) % 12 + 12) % 12 + shift
            const pitches: Array<int> = []
            for (let interval = 0; interval < 32 && pitches.length < 5; interval++) {
                if ((bits & (1 << interval)) !== 0) {pitches.push(base + interval)}
            }
            const rotate = Math.min(Math.max(inversion, 0), Math.max(pitches.length - 1, 0))
            return pitches.map((pitch, index) => index < rotate ? pitch + 12 : pitch)
                .toSorted((left, right) => left - right).filter(pitch => pitch >= 0 && pitch <= 127)
        }, [])
    }
}
