import {AudioFileBox, PlayfieldDeviceBox, PlayfieldSampleBox} from "@opendaw/studio-boxes"
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
    readonly #parametric: ParameterAdapterSet

    constructor(context: BoxAdaptersContext, box: PlayfieldDeviceBox) {
        this.#context = context
        this.#box = box

        this.#samples = IndexedBoxAdapterCollection.create(
            box.samples, box => context.boxAdapters.adapterFor(box, PlayfieldSampleBoxAdapter), Pointers.Sample)
        this.#parametric = new ParameterAdapterSet(this.#context)
    }

    reset(): void {this.#samples.adapters().forEach(adapter => adapter.box.delete())}

    chop({file, startKey, slices}: PlayfieldChopOptions): void {
        const endKey = startKey + slices.length - 1
        this.#samples.adapters()
            .filter(adapter => {
                const index = adapter.box.index.getValue()
                return index >= startKey && index <= endKey
            })
            .forEach(adapter => adapter.box.delete())
        slices.forEach(({start, end}, sliceIndex) => {
            PlayfieldSampleBox.create(this.#context.boxGraph, UUID.generate(), box => {
                box.file.refer(file)
                box.device.refer(this.#box.samples)
                box.index.setValue(startKey + sliceIndex)
                box.sampleStart.setValue(start)
                box.sampleEnd.setValue(end)
                box.exclude.setValue(true)
            })
        })
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