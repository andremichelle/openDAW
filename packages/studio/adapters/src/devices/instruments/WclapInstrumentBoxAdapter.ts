import {WclapInstrumentBox} from "@opendaw/studio-boxes"
import {Option, UUID} from "@opendaw/lib-std"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class WclapInstrumentBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Wclap

    readonly #context: BoxAdaptersContext
    readonly #box: WclapInstrumentBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter = {} as const

    constructor(context: BoxAdaptersContext, box: WclapInstrumentBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
    }

    get box(): WclapInstrumentBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}
    get urlField(): StringField {return this.#box.url}
    get clapIdField(): StringField {return this.#box.clapId}

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
}
