import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Guitar} from "@opendaw/lib-dsp"
import {GuitarDeviceBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {Address, BooleanField, Float32Field, Int32Field, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

type ParameterPointers = Pointers.Automation | Pointers.MIDIControl | Pointers.Modulation

export class GuitarDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    static readonly Modes: ReadonlyArray<string> = ["Chords", "Keys"]
    static readonly Rates: ReadonlyArray<string> = ["½×", "1×", "2×"]
    // WASM CONTRACT: the body order mirrors `BODY_NAMES` in device-guitar
    static readonly Bodies: ReadonlyArray<string> = ["Off", "Dreadnought", "Classical", "Parlor", "Jumbo", "Archtop", "Electric Neck", "Electric Bridge"]
    // WASM CONTRACT: the pick order mirrors `Pick` in device-guitar
    static readonly Picks: ReadonlyArray<string> = ["Finger", "Thumb", "Nail", "Plectrum"]

    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = "manuals/devices/instruments/guitar"

    readonly #context: BoxAdaptersContext
    readonly #box: GuitarDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: GuitarDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): GuitarDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: GuitarDeviceBox) {
        const unipolar = (field: Float32Field<ParameterPointers>, name: string) =>
            this.#parametric.createParameter(field, ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), name)
        const choice = (field: Int32Field<ParameterPointers>, labels: ReadonlyArray<string>, name: string) =>
            this.#parametric.createParameter(field, ValueMapping.linearInteger(0, labels.length - 1),
                StringMapping.indices("", labels), name)
        return {
            mode: choice(box.mode, GuitarDeviceBoxAdapter.Modes, "Mode"),
            rate: choice(box.rate, GuitarDeviceBoxAdapter.Rates, "Rate"),
            speed: unipolar(box.speed, "Speed"),
            speedVariation: unipolar(box.speedVariation, "± Speed"),
            velocity: unipolar(box.velocity, "Velocity"),
            velocityVariation: unipolar(box.velocityVariation, "± Velocity"),
            swing: unipolar(box.swing, "Swing"),
            accent: unipolar(box.accent, "Accent"),
            position: choice(box.position, Guitar.PositionNames, "Position"),
            tuning: choice(box.tuning, Guitar.TuningNames, "Tuning"),
            body: choice(box.body, GuitarDeviceBoxAdapter.Bodies, "Body"),
            damping: unipolar(box.damping, "Damping"),
            dampingVariation: unipolar(box.dampingVariation, "± Damping"),
            pluck: unipolar(box.pluck, "Pluck"),
            pluckVariation: unipolar(box.pluckVariation, "± Pluck"),
            tension: unipolar(box.tension, "Tension"),
            spot: unipolar(box.spot, "Spot"),
            characterVariation: unipolar(box.characterVariation, "Character"),
            pick: choice(box.pick, GuitarDeviceBoxAdapter.Picks, "Pick"),
            spread: unipolar(box.spread, "Spread"),
            volume: this.#parametric.createParameter(
                box.volume, ValueMapping.DefaultDecibel, StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Volume")
        } as const
    }
}
