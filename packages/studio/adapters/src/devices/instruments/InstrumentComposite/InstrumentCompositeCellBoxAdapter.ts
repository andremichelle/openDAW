import {Pointers} from "@opendaw/studio-enums"
import {InstrumentCompositeCellBox, PlayfieldDeviceBox} from "@opendaw/studio-boxes"
import {isInstanceOf, Option, Procedure, StringMapping, Subscription, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {MidiKeys} from "@opendaw/lib-dsp"
import {Address, BooleanField, Field, Int32Field} from "@opendaw/lib-box"
import {AudioEffectDeviceAdapter, CompositeCell, DeviceHost, Devices, MidiEffectDeviceAdapter} from "../../../DeviceAdapter"
import {LabeledAudioOutput} from "../../../LabeledAudioOutputsOwner"
import {IndexedBoxAdapter, IndexedBoxAdapterCollection} from "../../../IndexedBoxAdapterCollection"
import {BoxAdaptersContext} from "../../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../../ParameterAdapterSet"
import {AudioUnitInput} from "../../../audio-unit/AudioUnitInput"
import {AutomatableParameterFieldAdapter} from "../../../AutomatableParameterFieldAdapter"
import {AudioUnitInputAdapter} from "../../../audio-unit/AudioUnitInputAdapter"
import {AudioUnitBoxAdapter} from "../../../audio-unit/AudioUnitBoxAdapter"
import {InstrumentCompositeBoxAdapter} from "../InstrumentCompositeBoxAdapter"
import {PlayfieldDeviceBoxAdapter} from "../PlayfieldDeviceBoxAdapter"
import {PlayfieldPads} from "../Playfield/PlayfieldPads"

export type CellCompositeAdapter = InstrumentCompositeBoxAdapter | PlayfieldDeviceBoxAdapter

export class InstrumentCompositeCellBoxAdapter implements CompositeCell, IndexedBoxAdapter {
    readonly class = "device-host"
    readonly cellKind = "instrument"

    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: InstrumentCompositeCellBox

    readonly #input: AudioUnitInput
    readonly #midiEffects: IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MIDIEffectHost>
    readonly #audioEffects: IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type
    readonly excludeParameter: Option<AutomatableParameterFieldAdapter<boolean>>

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
        this.excludeParameter = PlayfieldPads.isPad(box)
            ? Option.wrap(this.#parametric.createParameter(box.exclude, ValueMapping.bool, StringMapping.bool, "Exclude"))
            : Option.None
    }

    get box(): InstrumentCompositeCellBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get keyField(): Int32Field {return this.#box.key}
    get isPad(): boolean {return PlayfieldPads.isPad(this.#box)}
    get label(): string {
        const index = this.#box.index.getValue()
        return this.#input.label.unwrapOrElse(() => this.isPad ? MidiKeys.toFullString(index) : `Layer ${index + 1}`)
    }
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

    compositeDevice(): CellCompositeAdapter {
        const box = this.#box.composite.targetVertex.unwrap("composite.target").box
        return isInstanceOf(box, PlayfieldDeviceBox)
            ? this.#context.boxAdapters.adapterFor(box, PlayfieldDeviceBoxAdapter)
            : this.#context.boxAdapters.adapterFor(box, InstrumentCompositeBoxAdapter)
    }

    deviceHost(): DeviceHost {return this.compositeDevice().deviceHost()}
    asCompositeCell(): Option<CompositeCell> {return Option.wrap(this)}
    siblings(): ReadonlyArray<CompositeCell> {return this.compositeDevice().cells.adapters()}
    subscribeSiblings(observer: Procedure<ReadonlyArray<CompositeCell>>): Subscription {
        const {cells} = this.compositeDevice()
        const notify = () => observer(cells.adapters())
        return cells.subscribe({onAdd: notify, onRemove: notify, onReorder: notify})
    }
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
