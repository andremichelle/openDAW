import {Pointers} from "@opendaw/studio-enums"
import {PlayfieldSampleBox} from "@opendaw/studio-boxes"
import {int, Option, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Field, Int32Field, StringField} from "@opendaw/lib-box"
import {
    AudioEffectDeviceAdapter,
    DeviceAccepts,
    DeviceHost,
    Devices,
    InstrumentDeviceBoxAdapter,
    MidiEffectDeviceAdapter
} from "../../../DeviceAdapter"
import {IndexedBoxAdapter, IndexedBoxAdapterCollection} from "../../../IndexedBoxAdapterCollection"
import {BoxAdaptersContext} from "../../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../../ParameterAdapterSet"
import {AudioFileBoxAdapter} from "../../../audio/AudioFileBoxAdapter"
import {Gate} from "./Gate"
import {TrackType} from "../../../timeline/TrackType"
import {AudioUnitInputAdapter} from "../../../audio-unit/AudioUnitInputAdapter"
import {AudioUnitBoxAdapter} from "../../../audio-unit/AudioUnitBoxAdapter"
import {PlayfieldDeviceBoxAdapter} from "../PlayfieldDeviceBoxAdapter"

export class PlayfieldSampleBoxAdapter implements DeviceHost, InstrumentDeviceBoxAdapter, IndexedBoxAdapter {
    readonly class = "device-host"
    readonly accepts: DeviceAccepts = false
    readonly type = "instrument"

    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: PlayfieldSampleBox

    readonly #midiEffects: IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MidiEffectHost>
    readonly #audioEffects: IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    #file: Option<AudioFileBoxAdapter> = Option.None

    constructor(context: BoxAdaptersContext, box: PlayfieldSampleBox) {
        this.#context = context
        this.#box = box

        this.#midiEffects = this.#terminator.own(IndexedBoxAdapterCollection.create(this.#box.midiEffects,
            box => this.#context.boxAdapters.adapterFor(box, Devices.isMidiEffect), Pointers.MidiEffectHost))
        this.#audioEffects = this.#terminator.own(IndexedBoxAdapterCollection.create(this.#box.audioEffects,
            box => this.#context.boxAdapters.adapterFor(box, Devices.isAudioEffect), Pointers.AudioEffectHost))

        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.namedParameter = this.#wrapParameters(box)

        this.#terminator.own(
            this.#box.file.catchupAndSubscribe(pointer => {
                this.#file = pointer.targetVertex.map(({box}) => this.#context.boxAdapters.adapterFor(box, AudioFileBoxAdapter))
                this.#file.unwrapOrNull()?.getOrCreateLoader() // triggers preloading file if available
            })
        )
    }

    get box(): PlayfieldSampleBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get peakAddress(): Address {return this.#box.address.append(1001)}
    get indexField(): Int32Field {return this.#box.index}

    get gate(): Gate {return this.#box.gate.getValue()}
    get exclude(): boolean {return this.#box.exclude.getValue()}
    get label(): string {
        return `${this.device().labelField.getValue()} > ${this.#file.mapOr(file => file.box.fileName.getValue(), "No file")}`
    }
    get fileLabel(): string {return `${this.#file.mapOr(file => file.box.fileName.getValue(), "No file")}`}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get acceptsMidiEvents(): boolean {return true}
    get midiEffectsField(): Field<Pointers.MidiEffectHost> {return this.#box.midiEffects}
    get inputField(): Field<Pointers.InstrumentHost | Pointers.AudioOutput> {return this.audioUnitBoxAdapter().box.input}
    get audioEffectsField(): Field<Pointers.AudioEffectHost> {return this.#box.audioEffects}
    get tracksField(): Field<Pointers.TrackCollection> {return this.audioUnitBoxAdapter().box.tracks}
    get isAudioUnit(): boolean {return false}

    file(): Option<AudioFileBoxAdapter> {return this.#file}
    fileUUID(): UUID.Bytes {return this.#box.file.targetAddress.unwrap().uuid}

    resetParameters(): void {
        this.#box.mute.reset()
        this.#box.solo.reset()
        this.#box.exclude.reset()
        this.#box.polyphone.reset()
        this.#box.pitch.reset()
        this.#box.attack.reset()
        this.#box.release.reset()
        this.#box.sampleStart.reset()
        this.#box.sampleEnd.reset()
        this.#box.gate.reset()
    }

    copyToIndex(index: int): void {
        PlayfieldSampleBox.create(this.#box.graph, UUID.generate(), box => {
            box.file.refer(this.#box.file.targetVertex.unwrap())
            box.device.refer(this.#box.device.targetVertex.unwrap())
            box.index.setValue(index)
            box.mute.setValue(this.#box.mute.getValue())
            box.solo.setValue(this.#box.solo.getValue())
            box.sampleStart.setValue(this.#box.sampleStart.getValue())
            box.sampleEnd.setValue(this.#box.sampleEnd.getValue())
            box.attack.setValue(this.#box.attack.getValue())
            box.release.setValue(this.#box.release.getValue())
            box.pitch.setValue(this.#box.pitch.getValue())
            box.exclude.setValue(this.#box.exclude.getValue())
            box.gate.setValue(this.#box.gate.getValue())
            // TODO Copy effects?
        })
    }

    get midiEffects(): IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MidiEffectHost> {
        return this.#midiEffects
    }
    get inputAdapter(): Option<AudioUnitInputAdapter> {
        return Option.wrap(this)
    }
    get audioEffects(): IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost> {
        return this.#audioEffects
    }

    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}

    device(): PlayfieldDeviceBoxAdapter {
        return this.#context.boxAdapters
            .adapterFor(this.#box.device.targetVertex.unwrap().box, PlayfieldDeviceBoxAdapter)
    }

    deviceHost(): DeviceHost {return this.device().deviceHost()}
    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {this.#terminator.terminate()}

    #wrapParameters(box: PlayfieldSampleBox) {
        return {
            gate: this.#parametric.createParameter(box.gate, ValueMapping.linearInteger(0, 2), StringMapping.indices("", ["Off", "On", "Loop"]), "Gate"),
            mute: this.#parametric.createParameter(box.mute, ValueMapping.bool, StringMapping.bool, "Mute"),
            solo: this.#parametric.createParameter(box.solo, ValueMapping.bool, StringMapping.bool, "Solo"),
            polyphone: this.#parametric.createParameter(box.polyphone, ValueMapping.bool, StringMapping.bool, "Polyphone"),
            exclude: this.#parametric.createParameter(box.exclude, ValueMapping.bool, StringMapping.bool, "Exclude"),
            pitch: this.#parametric.createParameter(box.pitch, ValueMapping.linear(-1200, 1200), StringMapping.numeric({
                unit: "cents",
                bipolar: true,
                fractionDigits: 0
            }), "Pitch", 0.0),
            sampleStart: this.#parametric.createParameter(box.sampleStart, ValueMapping.unipolar(), StringMapping.percent(), "Start", 0.0),
            sampleEnd: this.#parametric.createParameter(box.sampleEnd, ValueMapping.unipolar(), StringMapping.percent(), "End", 1.0),
            attack: this.#parametric.createParameter(box.attack, ValueMapping.exponential(0.001, 5.0), StringMapping.numeric({
                unit: "s",
                unitPrefix: true,
                fractionDigits: 1
            }), "Attack"),
            release: this.#parametric.createParameter(box.release, ValueMapping.exponential(0.001, 5.0), StringMapping.numeric({
                unit: "s",
                unitPrefix: true,
                fractionDigits: 1
            }), "Release")
        } as const
    }
}