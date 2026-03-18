import {asInstanceOf, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {SpielwerkDeviceBox, WerkstattParameterBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceHost, Devices, MidiEffectDeviceAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"

export class SpielwerkDeviceBoxAdapter implements MidiEffectDeviceAdapter {
    readonly #terminator = new Terminator()

    readonly type = "midi-effect"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Spielwerk

    readonly #context: BoxAdaptersContext
    readonly #box: SpielwerkDeviceBox
    readonly #parametric: ParameterAdapterSet

    constructor(context: BoxAdaptersContext, box: SpielwerkDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.#terminator.own(
            box.parameters.pointerHub.catchupAndSubscribe({
                onAdded: (({box}) => this.#parametric
                    .createParameter(
                        asInstanceOf(box, WerkstattParameterBox).value,
                        ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 1}),
                        asInstanceOf(box, WerkstattParameterBox).label.getValue())),
                onRemoved: (({box}) => this.#parametric
                    .removeParameter(asInstanceOf(box, WerkstattParameterBox).value.address))
            })
        )
    }

    get box(): SpielwerkDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.MIDIEffectHost> {return this.#box.host}
    get parameters(): ParameterAdapterSet {return this.#parametric}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {this.#terminator.terminate()}
}
