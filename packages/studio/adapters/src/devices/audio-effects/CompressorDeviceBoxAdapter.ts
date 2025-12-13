import {CompressorDeviceBox} from "@opendaw/studio-boxes"
import {StringMapping, Terminable, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class CompressorDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"

    readonly #context: BoxAdaptersContext
    readonly #box: CompressorDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly #outputRegistration: Terminable
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: CompressorDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
        this.#outputRegistration = context.isMainThread
            ? context.audioOutputInfoRegistry.register({address: box.address, path: () => [box.label.getValue()]})
            : Terminable.Empty
    }

    get box(): CompressorDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {
        this.#parametric.terminate()
        this.#outputRegistration.terminate()
    }

    #wrapParameters(box: CompressorDeviceBox) {
        return {
            lookahead: this.#parametric.createParameter(
                box.lookahead, ValueMapping.bool, StringMapping.bool, "Lookahead"),
            automakeup: this.#parametric.createParameter(
                box.automakeup, ValueMapping.bool, StringMapping.bool, "Auto Makeup"),
            autoattack: this.#parametric.createParameter(
                box.autoattack, ValueMapping.bool, StringMapping.bool, "Auto Attack"),
            autorelease: this.#parametric.createParameter(
                box.autorelease, ValueMapping.bool, StringMapping.bool, "Auto Release"),
            inputgain: this.#parametric.createParameter(
                box.inputgain, ValueMapping.linear(-30.0, 30.0), StringMapping.decible, "Input Gain"),
            threshold: this.#parametric.createParameter(
                box.threshold, ValueMapping.linear(-60.0, 0.0), StringMapping.decible, "Threshold"),
            ratio: this.#parametric.createParameter(
                box.ratio, ValueMapping.exponential(1.0, 24.0),
                StringMapping.numeric({fractionDigits: 1}), "Ratio"),
            knee: this.#parametric.createParameter(
                box.knee, ValueMapping.linear(0.0, 24.0), StringMapping.decible, "Knee"),
            attack: this.#parametric.createParameter(
                box.attack, ValueMapping.linear(0.0, 100.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "Attack Time"),
            release: this.#parametric.createParameter(
                box.release, ValueMapping.linear(5.0, 1500.0),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "Release Time"),
            makeup: this.#parametric.createParameter(
                box.makeup, ValueMapping.linear(-40.0, 40.0), StringMapping.decible, "Makeup Gain"),
            mix: this.#parametric.createParameter(
                box.mix, ValueMapping.unipolar(), StringMapping.percent(), "Dry/Wet")
        } as const
    }
}