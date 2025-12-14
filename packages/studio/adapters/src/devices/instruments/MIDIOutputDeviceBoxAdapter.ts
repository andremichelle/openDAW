import {
    asInstanceOf,
    MutableObservableOption,
    ObservableOption,
    Option,
    StringMapping,
    Terminator,
    UUID,
    ValueMapping
} from "@opendaw/lib-std"
import {MIDIOutputBox, MIDIOutputDeviceBox, MIDIOutputParameterBox} from "@opendaw/studio-boxes"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class MIDIOutputDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly #terminator = new Terminator()

    readonly type = "instrument"
    readonly accepts = "midi"

    readonly #context: BoxAdaptersContext
    readonly #box: MIDIOutputDeviceBox
    readonly #midiDevice: MutableObservableOption<MIDIOutputBox>

    readonly #parametric: ParameterAdapterSet

    constructor(context: BoxAdaptersContext, box: MIDIOutputDeviceBox) {
        this.#context = context
        this.#box = box
        this.#midiDevice = new MutableObservableOption()
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.#terminator.ownAll(
            box.parameters.pointerHub.catchupAndSubscribe({
                onAdded: (({box}) => this.#parametric
                    .createParameter(
                        asInstanceOf(box, MIDIOutputParameterBox).value,
                        ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 1}), "", 0.0)),
                onRemoved: (({box}) => this.#parametric
                    .removeParameter(asInstanceOf(box, MIDIOutputParameterBox).value.address))
            }),
            this.#box.device.catchupAndSubscribe(({targetVertex}) => targetVertex.match({
                none: () => this.#midiDevice.clear(),
                some: ({box}) => this.#midiDevice.wrap(asInstanceOf(box, MIDIOutputBox))
            }))
        )
    }

    get box(): MIDIOutputDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}
    get parameters(): ParameterAdapterSet {return this.#parametric}
    get midiDevice(): ObservableOption<MIDIOutputBox> {return this.#midiDevice}

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