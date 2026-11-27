import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {CorrodeDeviceBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

const FrequencyParser = StringMapping.numeric({unit: "Hz", unitPrefix: true})
const FrequencyString: StringMapping<number> = {
    y: (text: string) => FrequencyParser.y(text),
    x: (hz: number) => hz >= 1000.0
        ? {value: (hz / 1000.0).toFixed(hz >= 10000.0 ? 1 : 2), unit: "kHz"}
        : {value: hz.toFixed(0), unit: "Hz"}
}

export class CorrodeDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    static readonly Modes: ReadonlyArray<string> = ["Noise", "Wide Noise", "Sine"]
    static readonly SineMode = 2
    static readonly widthToQ = (octaves: number): number => {
        const ratio = Math.pow(2.0, octaves)
        return Math.sqrt(ratio) / (ratio - 1.0)
    }

    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Corrode

    readonly #context: BoxAdaptersContext
    readonly #box: CorrodeDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: CorrodeDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): CorrodeDeviceBox {return this.#box}
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

    #wrapParameters(box: CorrodeDeviceBox) {
        return {
            mode: this.#parametric.createParameter(
                box.mode,
                ValueMapping.linearInteger(0, 2),
                StringMapping.indices("", CorrodeDeviceBoxAdapter.Modes), "Mode"),
            frequency: this.#parametric.createParameter(
                box.frequency,
                ValueMapping.exponential(50.0, 18000.0),
                FrequencyString, "Freq"),
            width: this.#parametric.createParameter(
                box.width,
                ValueMapping.exponential(0.08, 10.0),
                StringMapping.numeric({fractionDigits: 2}), "Width"),
            amount: this.#parametric.createParameter(
                box.amount,
                ValueMapping.linear(0.0, 100.0),
                StringMapping.numeric({fractionDigits: 1}), "Amount")
        } as const
    }
}
