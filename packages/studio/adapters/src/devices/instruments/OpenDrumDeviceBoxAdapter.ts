import {Option, UUID} from "@opendaw/lib-std"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {InstrumentBox} from "../../factories/InstrumentBox"

/** What every openDrum device adapter shares, a device only names its box, manual page and parameters. */
export abstract class OpenDrumDeviceBoxAdapter<B extends InstrumentBox, P> implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl: string
    readonly namedParameter: P

    readonly #context: BoxAdaptersContext
    readonly #box: B
    readonly #parametric: ParameterAdapterSet

    protected constructor(context: BoxAdaptersContext, box: B, manualUrl: string,
                          wrap: (parameter: ParameterAdapterSet, box: B) => P) {
        this.#context = context
        this.#box = box
        this.manualUrl = manualUrl
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = wrap(this.#parametric, box)
    }

    get box(): B {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {this.#parametric.terminate()}
}
