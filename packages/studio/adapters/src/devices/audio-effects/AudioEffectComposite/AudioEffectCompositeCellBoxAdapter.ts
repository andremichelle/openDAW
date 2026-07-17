import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectCompositeCellBox} from "@opendaw/studio-boxes"
import {int, Option, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Field, Int32Field, StringField} from "@opendaw/lib-box"
import {
    AudioEffectDeviceAdapter,
    DeviceHost,
    Devices,
    MidiEffectDeviceAdapter
} from "../../../DeviceAdapter"
import {LabeledAudioOutput} from "../../../LabeledAudioOutputsOwner"
import {IndexedBoxAdapter, IndexedBoxAdapterCollection} from "../../../IndexedBoxAdapterCollection"
import {BoxAdaptersContext} from "../../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../../ParameterAdapterSet"
import {AudioUnitInputAdapter} from "../../../audio-unit/AudioUnitInputAdapter"
import {AudioUnitBoxAdapter} from "../../../audio-unit/AudioUnitBoxAdapter"
import {AudioCompositeAdapter} from "./AudioCompositeAdapter"

// One ENTRY of an AudioEffectCompositeBox: a ONE-SIDED DeviceHost. It hosts an audio-fx chain and NO midi chain
// (`midiEffects` / `midiEffectsField` are `None`), and no instrument — the composite hands it a signal. Being a
// DeviceHost is what lets the device panel be ENTERED on this cell (userEditingManager.audioUnit.edit(cellBox)),
// exactly as a Playfield slot is entered.
export class AudioEffectCompositeCellBoxAdapter implements DeviceHost, IndexedBoxAdapter {
    readonly class = "device-host"

    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: AudioEffectCompositeCellBox

    readonly #audioEffects: IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: AudioEffectCompositeCellBox) {
        this.#context = context
        this.#box = box
        this.#audioEffects = this.#terminator.own(IndexedBoxAdapterCollection.create(this.#box.audioEffects,
            box => this.#context.boxAdapters.adapterFor(box, Devices.isAudioEffect), Pointers.AudioEffectHost))
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): AudioEffectCompositeCellBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get label(): string {return this.#box.label.getValue()}

    // An audio entry hosts an audio chain only: no midi chain, and no instrument to head it.
    get audioEffects(): Option<IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>> {
        return Option.wrap(this.#audioEffects)
    }
    get midiEffects(): Option<IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MIDIEffectHost>> {
        return Option.None
    }
    get audioEffectsField(): Option<Field<Pointers.AudioEffectHost>> {return Option.wrap(this.#box.audioEffects)}
    get midiEffectsField(): Option<Field<Pointers.MIDIEffectHost>> {return Option.None}
    get inputAdapter(): Option<AudioUnitInputAdapter> {return Option.None}
    get hostsInstrument(): boolean {return false}
    get isAudioUnit(): boolean {return false}

    get inputField(): Field<Pointers.InstrumentHost | Pointers.AudioOutput> {
        return this.audioUnitBoxAdapter().box.input
    }
    get tracksField(): Field<Pointers.TrackCollection> {return this.audioUnitBoxAdapter().box.tracks}

    // The COMPOSITE DEVICE this entry belongs to, resolved through the entry's mandatory `composite` pointer.
    compositeDevice(): AudioCompositeAdapter {
        return this.#context.boxAdapters
            .adapterFor(this.#box.composite.targetVertex.unwrap("composite.target").box, AudioCompositeAdapter)
    }

    // The host the OWNING COMPOSITE lives in — where the panel returns to when leaving this entry. NOT the
    // composite itself (see `compositeDevice`): an entry's host is where its composite sits in a chain.
    deviceHost(): DeviceHost {return this.compositeDevice().deviceHost()}
    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.label, children: () => Option.None}
        for (const effect of this.#audioEffects.adapters()) {
            yield* effect.labeledAudioOutputs()
        }
    }

    terminate(): void {this.#terminator.terminate()}

    copyToIndex(index: int): void {
        AudioEffectCompositeCellBox.create(this.#box.graph, UUID.generate(), box => {
            box.composite.refer(this.#box.composite.targetVertex.unwrap("composite.target"))
            box.index.setValue(index)
            box.label.setValue(this.#box.label.getValue())
            box.gain.setValue(this.#box.gain.getValue())
            box.pan.setValue(this.#box.pan.getValue())
            box.mute.setValue(this.#box.mute.getValue())
            box.solo.setValue(this.#box.solo.getValue())
        })
    }

    #wrapParameters(box: AudioEffectCompositeCellBox) {
        return {
            gain: this.#parametric.createParameter(box.gain, ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Gain"),
            pan: this.#parametric.createParameter(box.pan, ValueMapping.bipolar(), StringMapping.panning, "Pan", 0.5),
            mute: this.#parametric.createParameter(box.mute, ValueMapping.bool, StringMapping.bool, "Mute"),
            solo: this.#parametric.createParameter(box.solo, ValueMapping.bool, StringMapping.bool, "Solo")
        } as const
    }
}
