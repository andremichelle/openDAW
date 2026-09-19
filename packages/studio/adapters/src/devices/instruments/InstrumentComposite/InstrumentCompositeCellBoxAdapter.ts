import {Pointers} from "@opendaw/studio-enums"
import {InstrumentCompositeCellBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Field, Int32Field, StringField} from "@opendaw/lib-box"
import {AudioEffectDeviceAdapter, DeviceHost, Devices, MidiEffectDeviceAdapter} from "../../../DeviceAdapter"
import {LabeledAudioOutput} from "../../../LabeledAudioOutputsOwner"
import {IndexedBoxAdapter, IndexedBoxAdapterCollection} from "../../../IndexedBoxAdapterCollection"
import {BoxAdaptersContext} from "../../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../../ParameterAdapterSet"
import {AudioUnitInput} from "../../../audio-unit/AudioUnitInput"
import {AudioUnitInputAdapter} from "../../../audio-unit/AudioUnitInputAdapter"
import {AudioUnitBoxAdapter} from "../../../audio-unit/AudioUnitBoxAdapter"
import {InstrumentCompositeBoxAdapter} from "../InstrumentCompositeBoxAdapter"

// One LAYER of an InstrumentCompositeBox: a full DeviceHost, an audio unit minus tracks and sends. It hosts an
// instrument plus both effect chains, and leads back to the host the owning composite sits in.
export class InstrumentCompositeCellBoxAdapter implements DeviceHost, IndexedBoxAdapter {
    readonly class = "device-host"

    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: InstrumentCompositeCellBox

    readonly #input: AudioUnitInput
    readonly #midiEffects: IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MIDIEffectHost>
    readonly #audioEffects: IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: InstrumentCompositeCellBox) {
        this.#context = context
        this.#box = box
        this.#input = this.#terminator.own(new AudioUnitInput(box.instrument.pointerHub, context.boxAdapters))
        this.#midiEffects = this.#terminator.own(IndexedBoxAdapterCollection.create(box.midiEffects,
            box => context.boxAdapters.adapterFor(box, Devices.isMidiEffect), Pointers.MIDIEffectHost))
        this.#audioEffects = this.#terminator.own(IndexedBoxAdapterCollection.create(box.audioEffects,
            box => context.boxAdapters.adapterFor(box, Devices.isAudioEffect), Pointers.AudioEffectHost))
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(context))
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): InstrumentCompositeCellBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get label(): string {return this.#box.label.getValue()}
    get input(): AudioUnitInput {return this.#input}

    get midiEffects(): Option<IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MIDIEffectHost>> {
        return Option.wrap(this.#midiEffects)
    }
    get audioEffects(): Option<IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>> {
        return Option.wrap(this.#audioEffects)
    }
    get midiEffectsField(): Option<Field<Pointers.MIDIEffectHost>> {return Option.wrap(this.#box.midiEffects)}
    get audioEffectsField(): Option<Field<Pointers.AudioEffectHost>> {return Option.wrap(this.#box.audioEffects)}
    get inputAdapter(): Option<AudioUnitInputAdapter> {return this.#input.adapter()}
    get inputField(): Field<Pointers.InstrumentHost | Pointers.AudioOutput> {return this.#box.instrument}
    get tracksField(): Field<Pointers.TrackCollection> {return this.audioUnitBoxAdapter().box.tracks}
    get hostsInstrument(): boolean {return true}
    get isAudioUnit(): boolean {return false}

    compositeDevice(): InstrumentCompositeBoxAdapter {
        return this.#context.boxAdapters
            .adapterFor(this.#box.composite.targetVertex.unwrap("composite.target").box, InstrumentCompositeBoxAdapter)
    }

    deviceHost(): DeviceHost {return this.compositeDevice().deviceHost()}
    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield* this.#input.adapter().mapOr(input => input.labeledAudioOutputs(), [])
        for (const effect of this.#audioEffects.adapters()) {
            yield* effect.labeledAudioOutputs()
        }
    }

    terminate(): void {this.#terminator.terminate()}

    #wrapParameters(box: InstrumentCompositeCellBox) {
        return {
            gain: this.#parametric.createParameter(box.gain, ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Gain"),
            pan: this.#parametric.createParameter(box.pan, ValueMapping.bipolar(), StringMapping.panning, "Pan", 0.5),
            mute: this.#parametric.createParameter(box.mute, ValueMapping.bool, StringMapping.bool, "Mute"),
            solo: this.#parametric.createParameter(box.solo, ValueMapping.bool, StringMapping.bool, "Solo")
        } as const
    }
}
