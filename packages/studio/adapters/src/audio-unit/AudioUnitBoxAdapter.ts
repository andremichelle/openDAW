import {AudioUnitBox, CaptureAudioBox, CaptureMidiBox} from "@opendaw/studio-boxes"
import {assert, int, Option, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Field, Int32Field} from "@opendaw/lib-box"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices, MidiEffectDeviceAdapter} from "../DeviceAdapter"
import {AudioUnitTracks} from "./AudioUnitTracks"
import {AudioUnitInput} from "./AudioUnitInput"
import {IndexedBoxAdapterCollection} from "../IndexedBoxAdapterCollection"
import {ParameterAdapterSet} from "../ParameterAdapterSet"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {AuxSendBoxAdapter} from "./AuxSendBoxAdapter"
import {AudioUnitOutput} from "./AudioUnitOutput"
import {BoxAdapter} from "../BoxAdapter"
import {AudioUnitInputAdapter} from "./AudioUnitInputAdapter"
import {TrackBoxAdapter} from "../timeline/TrackBoxAdapter"

export class AudioUnitBoxAdapter implements DeviceHost, BoxAdapter {
    static VolumeMapper = ValueMapping.decibel(-96.0, -9.0, +6.0)

    readonly "class" = "device-host"

    readonly #terminator: Terminator = new Terminator()
    readonly #context: BoxAdaptersContext
    readonly #box: AudioUnitBox
    readonly #parametric: ParameterAdapterSet
    readonly #tracks: AudioUnitTracks
    readonly #input: AudioUnitInput
    readonly #midiEffects: IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MidiEffectHost>
    readonly #audioEffects: IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>
    readonly #auxSends: IndexedBoxAdapterCollection<AuxSendBoxAdapter, Pointers.AuxSend>
    readonly #output: AudioUnitOutput
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: AudioUnitBox) {
        this.#context = context
        this.#box = box

        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.#tracks = this.#terminator.own(new AudioUnitTracks(this, this.#context.boxAdapters))
        this.#input = this.#terminator.own(new AudioUnitInput(this.#box.input.pointerHub, this.#context.boxAdapters))
        this.#midiEffects = this.#terminator.own(IndexedBoxAdapterCollection.create(this.#box.midiEffects,
            box => this.#context.boxAdapters.adapterFor(box, Devices.isMidiEffect), Pointers.MidiEffectHost))
        this.#audioEffects = this.#terminator.own(IndexedBoxAdapterCollection.create(this.#box.audioEffects,
            box => this.#context.boxAdapters.adapterFor(box, Devices.isAudioEffect), Pointers.AudioEffectHost))
        this.#auxSends = this.#terminator.own(IndexedBoxAdapterCollection.create(this.#box.auxSends,
            box => this.#context.boxAdapters.adapterFor(box, AuxSendBoxAdapter), Pointers.AuxSend))
        this.#output = this.#terminator.own(new AudioUnitOutput(this.#box.output, this.#context.boxAdapters))
        this.namedParameter = this.#wrapParameters(box)

        this.#sanityCheck()
    }

    get box(): AudioUnitBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get type(): AudioUnitType {return this.#box.type.getValue() as AudioUnitType}
    get captureBox(): Option<CaptureAudioBox | CaptureMidiBox> {return this.#box.capture.targetVertex as Option<CaptureAudioBox | CaptureMidiBox>}
    get tracks(): AudioUnitTracks {return this.#tracks}
    get input(): AudioUnitInput {return this.#input}
    get midiEffects(): IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MidiEffectHost> {return this.#midiEffects}
    get audioEffects(): IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost> {return this.#audioEffects}
    get inputAdapter(): Option<AudioUnitInputAdapter> {return this.#input.getValue()}
    get auxSends(): IndexedBoxAdapterCollection<AuxSendBoxAdapter, Pointers.AuxSend> {return this.#auxSends}
    get output(): AudioUnitOutput {return this.#output}
    get isBus(): boolean {return this.input.getValue().mapOr(adapter => adapter.type === "bus", false)}
    get isInstrument(): boolean {return this.input.getValue().mapOr(adapter => adapter.type === "instrument", false)}
    get isOutput(): boolean {
        return this.#box.output.targetVertex.mapOr(output =>
            output.box.address.equals(this.#context.rootBoxAdapter.address), false)
    }

    get midiEffectsField(): Field<Pointers.MidiEffectHost> {return this.#box.midiEffects}
    get inputField(): Field<Pointers.InstrumentHost | Pointers.AudioOutput> {return this.#box.input}
    get audioEffectsField(): Field<Pointers.AudioEffectHost> {return this.#box.audioEffects}
    get tracksField(): Field<Pointers.TrackCollection> {return this.#box.tracks}
    get minimizedField(): BooleanField {return this.#input.getValue().unwrap().minimizedField}
    get isAudioUnit(): boolean {return true}
    get label(): string {return this.#input.getValue().mapOr(input => input.labelField.getValue(), "")}

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this}

    indicesLimit(): [int, int] {
        const adapters = this.#context.rootBoxAdapter.audioUnits.adapters()
        const startIndex = this.indexField.getValue()
        const unitType = this.type
        let min: int = startIndex
        let max: int = startIndex
        while (min > 0) {
            if (adapters[min - 1].type === unitType) {min--} else {break}
        }
        while (max < adapters.length - 1) {
            if (adapters[max + 1].type === unitType) {max++} else {break}
        }
        return [min, max + 1]
    }

    move(delta: int): void {this.#context.rootBoxAdapter.audioUnits.move(this, delta)}
    moveTrack(adapter: TrackBoxAdapter, delta: int): void {this.#tracks.collection.move(adapter, delta)}
    deleteTrack(adapter: TrackBoxAdapter): void {this.#tracks.delete(adapter)}
    toString(): string {return `{${this.constructor.name}}`}
    terminate(): void {this.#terminator.terminate()}

    #wrapParameters(box: AudioUnitBox) {
        return {
            volume: this.#parametric.createParameter(
                box.volume,
                AudioUnitBoxAdapter.VolumeMapper,
                StringMapping.decible, "volume"),
            panning: this.#parametric.createParameter(
                box.panning,
                ValueMapping.bipolar(),
                StringMapping.panning, "panning", 0.5),
            mute: this.#parametric.createParameter(
                box.mute,
                ValueMapping.bool,
                StringMapping.bool, "mute"),
            solo: this.#parametric.createParameter(
                box.solo,
                ValueMapping.bool,
                StringMapping.bool, "solo")
        } as const
    }

    #sanityCheck(): void {
        const address = this.address.toString()
        const capture = this.#box.capture.targetAddress.unwrapOrUndefined()
        const fail = () => `AudioUnit '${address}' must have a capture. AudioUnit is typed ${this.type} and has input ${this.#box.input.pointerHub.incoming().at(0)?.box.name}, but capture is ${capture}`
        assert(this.type !== AudioUnitType.Instrument || this.#box.capture.targetAddress.nonEmpty(), fail)
    }
}