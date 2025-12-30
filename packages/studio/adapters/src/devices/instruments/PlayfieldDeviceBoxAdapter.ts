import {PlayfieldDeviceBox} from "@opendaw/studio-boxes"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {Option, UUID} from "@opendaw/lib-std"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {IndexedBoxAdapterCollection} from "../../IndexedBoxAdapterCollection"
import {PlayfieldSampleBoxAdapter} from "./Playfield/PlayfieldSampleBoxAdapter"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {LabeledAudioOutput, LabeledAudioOutputsOwner} from "../../LabeledAudioOutputsOwner"

export class PlayfieldDeviceBoxAdapter implements InstrumentDeviceBoxAdapter, LabeledAudioOutputsOwner {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = "manuals/devices/instruments/playfield"

    readonly #context: BoxAdaptersContext
    readonly #box: PlayfieldDeviceBox

    readonly #samples: IndexedBoxAdapterCollection<PlayfieldSampleBoxAdapter, Pointers.Sample>
    readonly #parametric: ParameterAdapterSet

    constructor(context: BoxAdaptersContext, box: PlayfieldDeviceBox) {
        this.#context = context
        this.#box = box

        this.#samples = IndexedBoxAdapterCollection.create(
            box.samples, box => context.boxAdapters.adapterFor(box, PlayfieldSampleBoxAdapter), Pointers.Sample)
        this.#parametric = new ParameterAdapterSet(this.#context)
    }

    reset(): void {this.#samples.adapters().forEach(adapter => adapter.box.delete())}

    get box(): PlayfieldDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}
    get samples(): IndexedBoxAdapterCollection<PlayfieldSampleBoxAdapter, Pointers.Sample> {return this.#samples}
    get context(): BoxAdaptersContext {return this.#context}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {
            address: this.address,
            label: this.labelField.getValue(),
            children: () => Option.None
        }
        for (const sample of this.#samples.adapters()) {
            yield {
                address: sample.address,
                label: sample.fileLabel,
                children: () => Option.wrap(sample.labeledAudioOutputs())
            }
        }
    }

    terminate(): void {
        this.#parametric.terminate()
    }
}