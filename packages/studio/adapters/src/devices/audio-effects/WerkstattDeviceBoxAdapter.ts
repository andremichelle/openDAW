import {Observable, Option, Terminator, UUID} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {ScriptParamDeclaration} from "../../ScriptParamDeclaration"

export class WerkstattDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly #terminator = new Terminator()

    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Werkstatt

    readonly #context: BoxAdaptersContext
    readonly #box: WerkstattDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly #codeChanged: Observable<void>

    constructor(context: BoxAdaptersContext, box: WerkstattDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        const {terminable, codeChanged} = ScriptParamDeclaration.subscribeScriptParams(this.#parametric, box.code, box.parameters)
        this.#terminator.own(terminable)
        this.#codeChanged = codeChanged
    }

    get box(): WerkstattDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    get parameters(): ParameterAdapterSet {return this.#parametric}
    get codeChanged(): Observable<void> {return this.#codeChanged}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {this.#terminator.terminate()}
}
