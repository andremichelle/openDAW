import {Observable, Option, Terminator, UUID} from "@opendaw/lib-std"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {ApparatDeviceBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {ScriptDeclaration} from "../../ScriptDeclaration"

export class ApparatDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly #terminator = new Terminator()

    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Apparat

    readonly #context: BoxAdaptersContext
    readonly #box: ApparatDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly #codeChanged: Observable<void>

    constructor(context: BoxAdaptersContext, box: ApparatDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        const {terminable, codeChanged} = ScriptDeclaration.subscribeScriptParams(this.#parametric, box.code, box.parameters)
        this.#terminator.own(terminable)
        this.#codeChanged = codeChanged
    }

    get box(): ApparatDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}
    get parameters(): ParameterAdapterSet {return this.#parametric}
    get codeChanged(): Observable<void> {return this.#codeChanged}

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
