import {Pointers} from "@moises-ai/studio-enums"
import {clampUnit, Random, StringMapping, unitValue, UUID, ValueMapping} from "@moises-ai/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@moises-ai/lib-box"
import {VelocityDeviceBox} from "@moises-ai/studio-boxes"
import {DeviceHost, Devices, MidiEffectDeviceAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {ppqn} from "@moises-ai/lib-dsp"

export class VelocityDeviceBoxAdapter implements MidiEffectDeviceAdapter {
    readonly type = "midi-effect"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Velocity

    readonly #context: BoxAdaptersContext
    readonly #box: VelocityDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly #random: Random
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: VelocityDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.#random = Random.create()
        this.namedParameter = this.#wrapParameters(box)
    }

    computeVelocity(position: ppqn, original: unitValue): unitValue {
        const {magnetPosition, magnetStrength, randomSeed, randomAmount, offset, mix} = this.namedParameter
        this.#random.setSeed(randomSeed.valueAt(position) + position)
        const magnet = original + (magnetPosition.valueAt(position) - original) * magnetStrength.valueAt(position)
        const random = (this.#random.uniform() * 2.0 - 1.0) * randomAmount.valueAt(position)
        const delta = offset.valueAt(position)
        const wet = mix.valueAt(position)
        return original * (1.0 - wet) + (clampUnit(magnet + random + delta)) * wet
    }

    get box(): VelocityDeviceBox {return this.#box}
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

    #wrapParameters(box: VelocityDeviceBox) {
        return {
            magnetPosition: this.#parametric.createParameter(
                box.magnetPosition,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Position"),
            magnetStrength: this.#parametric.createParameter(
                box.magnetStrength,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Strength"),
            randomSeed: this.#parametric.createParameter(
                box.randomSeed,
                ValueMapping.linearInteger(0, 0xFFFF),
                StringMapping.numeric({unit: "", fractionDigits: 0}), "Seed"),
            randomAmount: this.#parametric.createParameter(
                box.randomAmount,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Amount"),
            offset: this.#parametric.createParameter(
                box.offset,
                ValueMapping.bipolar(),
                StringMapping.percent(), "Offset"),
            mix: this.#parametric.createParameter(
                box.mix,
                ValueMapping.unipolar(),
                StringMapping.percent(), "Mix")
        } as const
    }
}