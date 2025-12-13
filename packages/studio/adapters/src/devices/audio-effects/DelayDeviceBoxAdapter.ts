import {DelayDeviceBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, Terminable, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {Fraction} from "@opendaw/lib-dsp"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class DelayDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    static OffsetFractions = Fraction.builder()
        .add([1, 1]).add([1, 2]).add([1, 3]).add([1, 4])
        .add([3, 16]).add([1, 6]).add([1, 8]).add([3, 32])
        .add([1, 12]).add([1, 16]).add([3, 64]).add([1, 24])
        .add([1, 32]).add([1, 48]).add([1, 64])
        .add([1, 96]).add([1, 128])
        .asDescendingArray()

    static OffsetStringMapping = StringMapping.indices("", this.OffsetFractions.map(([n, d]) => `${n}/${d}`))

    readonly type = "audio-effect"
    readonly accepts = "audio"

    readonly #context: BoxAdaptersContext
    readonly #box: DelayDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly #outputRegistration: Terminable
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: DelayDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
        this.#outputRegistration = context.isMainThread
            ? context.audioOutputInfoRegistry.register({address: box.address, owner: Option.None, label: () => box.label.getValue()})
            : Terminable.Empty
    }

    get box(): DelayDeviceBox {return this.#box}
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

    #wrapParameters(box: DelayDeviceBox) {
        return {
            delay: this.#parametric.createParameter(
                box.delay,
                ValueMapping.linearInteger(0, DelayDeviceBoxAdapter.OffsetFractions.length - 1),
                DelayDeviceBoxAdapter.OffsetStringMapping, "delay"),
            feedback: this.#parametric.createParameter(
                box.feedback,
                ValueMapping.unipolar(),
                StringMapping.numeric({unit: "%", fractionDigits: 0}), "feedback"),
            cross: this.#parametric.createParameter(
                box.cross,
                ValueMapping.unipolar(),
                StringMapping.numeric({unit: "%", fractionDigits: 0}), "cross"),
            filter: this.#parametric.createParameter(
                box.filter,
                ValueMapping.bipolar(),
                StringMapping.numeric({unit: "%", fractionDigits: 0}), "filter", 0.5),
            dry: this.#parametric.createParameter(
                box.dry,
                ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "db", fractionDigits: 1}), "dry"),
            wet: this.#parametric.createParameter(
                box.wet,
                ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "db", fractionDigits: 1}), "wet")
        } as const
    }
}