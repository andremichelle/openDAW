import {TapeDeviceBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {TrackType} from "../../timeline/TrackType"

export class TapeDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Tape

    readonly #context: BoxAdaptersContext
    readonly #box: TapeDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: TapeDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): TapeDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Audio}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return false}

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

    #wrapParameters(box: TapeDeviceBox) {
        return {
            flutter: this.#parametric.createParameter(
                box.flutter,
                ValueMapping.unipolar(),
                StringMapping.percent(), "flutter"),
            wow: this.#parametric.createParameter(
                box.wow,
                ValueMapping.unipolar(),
                StringMapping.percent(), "wow"),
            noise: this.#parametric.createParameter(
                box.noise,
                ValueMapping.unipolar(),
                StringMapping.percent(), "noise"),
            saturation: this.#parametric.createParameter(
                box.saturation,
                ValueMapping.unipolar(),
                StringMapping.percent(), "saturation")
        } as const
    }
}