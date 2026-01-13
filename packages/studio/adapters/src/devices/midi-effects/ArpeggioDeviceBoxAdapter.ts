import {ArpeggioDeviceBox} from "@moises-ai/studio-boxes"
import {Pointers} from "@moises-ai/studio-enums"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@moises-ai/lib-box"
import {Fraction} from "@moises-ai/lib-dsp"
import {StringMapping, UUID, ValueMapping} from "@moises-ai/lib-std"
import {DeviceHost, Devices, MidiEffectDeviceAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class ArpeggioDeviceBoxAdapter implements MidiEffectDeviceAdapter {
    static RateFractions = Fraction.builder()
        .add([1, 1]).add([1, 2]).add([1, 3]).add([1, 4])
        .add([3, 16]).add([1, 6]).add([1, 8]).add([3, 32])
        .add([1, 12]).add([1, 16]).add([3, 64]).add([1, 24])
        .add([1, 32]).add([1, 48]).add([1, 64])
        .add([1, 96]).add([1, 128])
        .asDescendingArray()

    static RateStringMapping = StringMapping.indices("", this.RateFractions.map(([n, d]) => `${n}/${d}`))

    readonly type = "midi-effect"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Arpeggio

    readonly #context: BoxAdaptersContext
    readonly #box: ArpeggioDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: ArpeggioDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): ArpeggioDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.MIDIEffectHost> {return this.#box.host}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: ArpeggioDeviceBox) {
        return {
            modeIndex: this.#parametric.createParameter(
                box.modeIndex,
                ValueMapping.linearInteger(0, 2),
                StringMapping.indices("", ["Up", "Down", "UpDown"]), "mode"),
            numOctaves: this.#parametric.createParameter(
                box.numOctaves,
                ValueMapping.linearInteger(1, 5),
                StringMapping.numeric({unit: "", fractionDigits: 0}), "Octaves"),
            rate: this.#parametric.createParameter(
                box.rateIndex,
                ValueMapping.linearInteger(0, ArpeggioDeviceBoxAdapter.RateFractions.length - 1),
                ArpeggioDeviceBoxAdapter.RateStringMapping, "Rate"),
            gate: this.#parametric.createParameter(
                box.gate,
                ValueMapping.linear(0.0, 2.0),
                StringMapping.percent({fractionDigits: 0}), "Gate"),
            repeat: this.#parametric.createParameter(
                box.repeat,
                ValueMapping.linearInteger(1, 16),
                StringMapping.numeric({fractionDigits: 0}), "Repeat"),
            velocity: this.#parametric.createParameter(
                box.velocity,
                ValueMapping.bipolar(),
                StringMapping.percent({fractionDigits: 0, bipolar: false}), "Velocity")
        } as const
    }
}