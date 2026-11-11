import {AudioFileBox, PlayfieldDeviceBox} from "@opendaw/studio-boxes"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {int, Option, unitValue, UUID} from "@opendaw/lib-std"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {IndexedBoxAdapterCollection} from "../../IndexedBoxAdapterCollection"
import {PlayfieldSampleBoxAdapter} from "./Playfield/PlayfieldSampleBoxAdapter"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {LabeledAudioOutput, LabeledAudioOutputsOwner} from "../../LabeledAudioOutputsOwner"
import {InstrumentCompositeCellBoxAdapter} from "./InstrumentComposite/InstrumentCompositeCellBoxAdapter"
import {PlayfieldPads} from "./Playfield/PlayfieldPads"

export type PlayfieldChopSlice = {start: unitValue, end: unitValue}

export type PlayfieldChopOptions = {
    file: AudioFileBox
    startKey: int
    slices: ReadonlyArray<PlayfieldChopSlice>
}

export class PlayfieldDeviceBoxAdapter implements InstrumentDeviceBoxAdapter, LabeledAudioOutputsOwner {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Playfield

    readonly #context: BoxAdaptersContext
    readonly #box: PlayfieldDeviceBox

    readonly #samples: IndexedBoxAdapterCollection<PlayfieldSampleBoxAdapter, Pointers.Sample>
    readonly #pads: IndexedBoxAdapterCollection<InstrumentCompositeCellBoxAdapter, Pointers.InstrumentCompositeCell>
    readonly #parametric: ParameterAdapterSet

    constructor(context: BoxAdaptersContext, box: PlayfieldDeviceBox) {
        this.#context = context
        this.#box = box

        this.#samples = IndexedBoxAdapterCollection.create(
            box.samples, box => context.boxAdapters.adapterFor(box, PlayfieldSampleBoxAdapter), Pointers.Sample)
        this.#pads = IndexedBoxAdapterCollection.create(box.pads,
            box => context.boxAdapters.adapterFor(box, InstrumentCompositeCellBoxAdapter), Pointers.InstrumentCompositeCell)
        this.#parametric = new ParameterAdapterSet(this.#context)
    }

    reset(): void {this.#pads.adapters().forEach(adapter => adapter.box.delete())}

    chop({file, startKey, slices}: PlayfieldChopOptions): void {
        slices.forEach(({start, end}, sliceIndex) => PlayfieldPads.create(this.#context.boxGraph, this.#box, file,
            startKey + sliceIndex, {sampleStart: start, sampleEnd: end, exclude: true}))
    }

    get box(): PlayfieldDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}
    /** @deprecated The slots of projects before the pads, empty once a project loaded. */
    get samples(): IndexedBoxAdapterCollection<PlayfieldSampleBoxAdapter, Pointers.Sample> {return this.#samples}
    get cells(): IndexedBoxAdapterCollection<InstrumentCompositeCellBoxAdapter, Pointers.InstrumentCompositeCell> {return this.#pads}
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
        for (const pad of this.#pads.adapters()) {
            yield {address: pad.address, label: pad.label, children: () => Option.wrap(pad.labeledAudioOutputs())}
        }
    }

    terminate(): void {
        this.#samples.terminate()
        this.#pads.terminate()
        this.#parametric.terminate()
    }
}