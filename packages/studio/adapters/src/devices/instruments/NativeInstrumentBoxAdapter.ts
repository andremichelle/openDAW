import {NativeInstrumentBox} from "@opendaw/studio-boxes"
import {Option, Terminator, UUID} from "@opendaw/lib-std"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {WclapParameterAdapters} from "../WclapParameterAdapters"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class NativeInstrumentBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = ""

    readonly #context: BoxAdaptersContext
    readonly #box: NativeInstrumentBox
    readonly #terminator = new Terminator()
    readonly #parametric: ParameterAdapterSet

    constructor(context: BoxAdaptersContext, box: NativeInstrumentBox) {
        this.#context = context
        this.#box = box
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.#terminator.own(WclapParameterAdapters.subscribe(this.#parametric, box.parameters))
    }

    get box(): NativeInstrumentBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}
    get formatField(): StringField {return this.#box.format}
    get pluginIdField(): StringField {return this.#box.pluginId}
    get pluginNameField(): StringField {return this.#box.pluginName}
    get vendorField(): StringField {return this.#box.vendor}
    get parameters(): ParameterAdapterSet {return this.#parametric}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {this.#terminator.terminate()}
}
