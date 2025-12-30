import {TidalDeviceBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {Fraction} from "@opendaw/lib-dsp"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class TidalDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    static RateFractions: ReadonlyArray<Fraction> = Fraction.builder()
        .add([1, 1]).add([1, 2]).add([1, 3]).add([1, 4])
        .add([3, 16]).add([1, 6]).add([1, 8]).add([3, 32])
        .add([1, 12]).add([1, 16]).add([3, 64]).add([1, 24])
        .add([1, 32]).add([1, 48]).add([1, 64])
        .add([1, 96]).add([1, 128])
        .asDescendingArray()

    static RateStringMapping = StringMapping.indices("", this.RateFractions.map(([n, d]) => `${n}/${d}`))

    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = "manuals/devices/audio/tidal"

    readonly #context: BoxAdaptersContext
    readonly #box: TidalDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: TidalDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): TidalDeviceBox {return this.#box}
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

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: TidalDeviceBox) {
        const {RateFractions, RateStringMapping} = TidalDeviceBoxAdapter
        return {
            slope: this.#parametric.createParameter(
                box.slope,
                ValueMapping.bipolar(),
                StringMapping.percent({fractionDigits: 1}), "Slope", 0.5),
            symmetry: this.#parametric.createParameter(
                box.symmetry,
                ValueMapping.unipolar(),
                StringMapping.percent({fractionDigits: 1, bipolar: true}), "Symmetry", 0.5),
            rate: this.#parametric.createParameter(
                box.rate,
                ValueMapping.values(RateFractions.map((_, index) => index)),
                RateStringMapping, "Rate", 0.0),
            depth: this.#parametric.createParameter(
                box.depth,
                ValueMapping.unipolar(),
                StringMapping.percent({fractionDigits: 1}), "Depth", 0.0),
            offset: this.#parametric.createParameter(
                box.offset,
                ValueMapping.linear(-180.0, 180.0),
                StringMapping.numeric({unit: "°", fractionDigits: 0}), "Offset", 0.5),
            channelOffset: this.#parametric.createParameter(
                box.channelOffset,
                ValueMapping.linear(-180.0, 180.0),
                StringMapping.numeric({unit: "°", fractionDigits: 0}), "Ch. Offset", 0.5)
        } as const
    }
}