import {DelayDeviceBox} from "@moises-ai/studio-boxes"
import {Option, StringMapping, UUID, ValueMapping} from "@moises-ai/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {Fraction} from "@moises-ai/lib-dsp"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class DelayDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    static Fractions = Fraction.builder()
        .add([0, 1]).add([1, 128]).add([1, 96]).add([1, 64])
        .add([1, 48]).add([1, 32]).add([1, 24]).add([3, 64])
        .add([1, 16]).add([1, 12]).add([3, 32]).add([1, 8])
        .add([1, 6]).add([3, 16]).add([1, 4]).add([5, 16])
        .add([1, 3]).add([3, 8]).add([7, 16]).add([1, 2]).add([1, 1])
        .asAscendingArray()

    static FractionsStringMapping = StringMapping.indices("",
        this.Fractions.map(([n, d]) => n === 0 ? "Off" : `${n}/${d}`))

    static readonly MAX_MILLIS_TIME = 1000.0
    static readonly LFO_SPEED_MIN = 0.1
    static readonly LFO_SPEED_MAX = 5.0
    static readonly LFO_DEPTH_MAX = 50.0

    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Delay

    readonly #context: BoxAdaptersContext
    readonly #box: DelayDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: DelayDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
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

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: DelayDeviceBox) {
        return {
            preSyncTimeLeft: this.#parametric.createParameter(
                box.preSyncTimeLeft,
                ValueMapping.linearInteger(0, DelayDeviceBoxAdapter.Fractions.length - 1),
                DelayDeviceBoxAdapter.FractionsStringMapping, "pre sync L"),
            preMillisTimeLeft: this.#parametric.createParameter(
                box.preMillisTimeLeft,
                ValueMapping.powerByCenter(100.0, 0.0, DelayDeviceBoxAdapter.MAX_MILLIS_TIME),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "pre ms L"),
            preSyncTimeRight: this.#parametric.createParameter(
                box.preSyncTimeRight,
                ValueMapping.linearInteger(0, DelayDeviceBoxAdapter.Fractions.length - 1),
                DelayDeviceBoxAdapter.FractionsStringMapping, "pre sync R"),
            preMillisTimeRight: this.#parametric.createParameter(
                box.preMillisTimeRight,
                ValueMapping.powerByCenter(100.0, 0.0, DelayDeviceBoxAdapter.MAX_MILLIS_TIME),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "pre ms R"),
            delay: this.#parametric.createParameter(
                box.delayMusical,
                ValueMapping.linearInteger(0, DelayDeviceBoxAdapter.Fractions.length - 1),
                DelayDeviceBoxAdapter.FractionsStringMapping, "delay"),
            millisTime: this.#parametric.createParameter(
                box.delayMillis,
                ValueMapping.powerByCenter(100.0, 0.0, DelayDeviceBoxAdapter.MAX_MILLIS_TIME),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "ms"),
            feedback: this.#parametric.createParameter(
                box.feedback,
                ValueMapping.unipolar(),
                StringMapping.numeric({unit: "%", fractionDigits: 0}), "feedback"),
            cross: this.#parametric.createParameter(
                box.cross,
                ValueMapping.unipolar(),
                StringMapping.numeric({unit: "%", fractionDigits: 0}), "cross"),
            lfoSpeed: this.#parametric.createParameter(
                box.lfoSpeed,
                ValueMapping.exponential(DelayDeviceBoxAdapter.LFO_SPEED_MIN, DelayDeviceBoxAdapter.LFO_SPEED_MAX),
                StringMapping.numeric({unit: "Hz", fractionDigits: 2}), "lfo speed"),
            lfoDepth: this.#parametric.createParameter(
                box.lfoDepth,
                ValueMapping.power(4.0, 0.0, DelayDeviceBoxAdapter.LFO_DEPTH_MAX),
                StringMapping.numeric({unit: "ms", fractionDigits: 1}), "lfo depth"),
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