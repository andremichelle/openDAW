import {
    asDefined,
    assert,
    AssertType,
    Class,
    isDefined,
    panic,
    SortedSet,
    Subscription,
    Terminable,
    UUID
} from "@opendaw/lib-std"
import {Box, Update} from "@opendaw/lib-box"
import {
    ArpeggioDeviceBox,
    AudioBusBox,
    AudioClipBox,
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioTimeStretchBox,
    AudioUnitBox,
    AuxSendBox,
    BoxVisitor,
    MaximizerDeviceBox,
    CompressorDeviceBox,
    CrusherDeviceBox,
    GateDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    DeviceInterfaceKnobBox,
    FoldDeviceBox,
    GrooveShuffleBox,
    MarkerBox,
    MIDIOutputDeviceBox,
    ModularAudioInputBox,
    ModularAudioOutputBox,
    ModularBox,
    ModularDeviceBox,
    ModuleConnectionBox,
    ModuleDelayBox,
    ModuleGainBox,
    ModuleMultiplierBox,
    NanoDeviceBox,
    NeuralAmpDeviceBox,
    NoteClipBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    PitchDeviceBox,
    PlayfieldDeviceBox,
    PlayfieldSampleBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    RootBox,
    SignatureEventBox,
    SoundfontDeviceBox,
    SoundfontFileBox,
    StereoToolDeviceBox,
    TapeDeviceBox,
    TidalDeviceBox,
    TimelineBox,
    TrackBox,
    TransientMarkerBox,
    UnknownAudioEffectDeviceBox,
    UnknownMidiEffectDeviceBox,
    ValueClipBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    VaporisateurDeviceBox,
    VelocityDeviceBox,
    WarpMarkerBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter} from "./audio-unit/AudioUnitBoxAdapter"
import {DelayDeviceBoxAdapter} from "./devices/audio-effects/DelayDeviceBoxAdapter"
import {ReverbDeviceBoxAdapter} from "./devices/audio-effects/ReverbDeviceBoxAdapter"
import {RevampDeviceBoxAdapter} from "./devices/audio-effects/RevampDeviceBoxAdapter"
import {AudioFileBoxAdapter} from "./audio/AudioFileBoxAdapter"
import {AudioRegionBoxAdapter} from "./timeline/region/AudioRegionBoxAdapter"
import {TimelineBoxAdapter} from "./timeline/TimelineBoxAdapter"
import {MarkerBoxAdapter} from "./timeline/MarkerBoxAdapter"
import {ModularAdapter} from "./modular/modular"
import {ModuleDelayAdapter} from "./modular/modules/delay"
import {ModuleMultiplierAdapter} from "./modular/modules/multiplier"
import {ModuleConnectionAdapter} from "./modular/connection"
import {ModularAudioOutputAdapter} from "./modular/modules/audio-output"
import {ModularAudioInputAdapter} from "./modular/modules/audio-input"
import {ModularDeviceBoxAdapter} from "./devices/audio-effects/ModularDeviceBoxAdapter"
import {DeviceInterfaceKnobAdapter} from "./modular/user-interface"
import {ModuleGainAdapter} from "./modular/modules/gain"
import {AudioBusBoxAdapter} from "./audio-unit/AudioBusBoxAdapter"
import {AuxSendBoxAdapter} from "./audio-unit/AuxSendBoxAdapter"
import {RootBoxAdapter} from "./RootBoxAdapter"
import {NoteEventBoxAdapter} from "./timeline/event/NoteEventBoxAdapter"
import {NoteRegionBoxAdapter} from "./timeline/region/NoteRegionBoxAdapter"
import {NoteEventCollectionBoxAdapter} from "./timeline/collection/NoteEventCollectionBoxAdapter"
import {ValueEventBoxAdapter} from "./timeline/event/ValueEventBoxAdapter"
import {ValueRegionBoxAdapter} from "./timeline/region/ValueRegionBoxAdapter"
import {ValueEventCollectionBoxAdapter} from "./timeline/collection/ValueEventCollectionBoxAdapter"
import {NoteClipBoxAdapter} from "./timeline/clip/NoteClipBoxAdapter"
import {AudioClipBoxAdapter} from "./timeline/clip/AudioClipBoxAdapter"
import {ValueClipBoxAdapter} from "./timeline/clip/ValueClipBoxAdapter"
import {TrackBoxAdapter} from "./timeline/TrackBoxAdapter"
import {TapeDeviceBoxAdapter} from "./devices/instruments/TapeDeviceBoxAdapter"
import {VaporisateurDeviceBoxAdapter} from "./devices/instruments/VaporisateurDeviceBoxAdapter"
import {ArpeggioDeviceBoxAdapter} from "./devices/midi-effects/ArpeggioDeviceBoxAdapter"
import {PitchDeviceBoxAdapter} from "./devices/midi-effects/PitchDeviceBoxAdapter"
import {NanoDeviceBoxAdapter} from "./devices/instruments/NanoDeviceBoxAdapter"
import {PlayfieldDeviceBoxAdapter} from "./devices/instruments/PlayfieldDeviceBoxAdapter"
import {StereoToolDeviceBoxAdapter} from "./devices/audio-effects/StereoToolDeviceBoxAdapter"
import {PlayfieldSampleBoxAdapter} from "./devices/instruments/Playfield/PlayfieldSampleBoxAdapter"
import {BoxAdaptersContext} from "./BoxAdaptersContext"
import {BoxAdapter} from "./BoxAdapter"
import {ZeitgeistDeviceBoxAdapter} from "./devices/midi-effects/ZeitgeistDeviceBoxAdapter"
import {GrooveShuffleBoxAdapter} from "./grooves/GrooveShuffleBoxAdapter"
import {UnknownAudioEffectDeviceBoxAdapter} from "./devices/audio-effects/UnknownAudioEffectDeviceBoxAdapter"
import {UnknownMidiEffectDeviceBoxAdapter} from "./devices/midi-effects/UnknownMidiEffectDeviceBoxAdapter"
import {SoundfontDeviceBoxAdapter} from "./devices/instruments/SoundfontDeviceBoxAdapter"
import {SoundfontFileBoxAdapter} from "./soundfont/SoundfontFileBoxAdapter"
import {MaximizerDeviceBoxAdapter} from "./devices/audio-effects/MaximizerDeviceBoxAdapter"
import {CompressorDeviceBoxAdapter} from "./devices/audio-effects/CompressorDeviceBoxAdapter"
import {GateDeviceBoxAdapter} from "./devices/audio-effects/GateDeviceBoxAdapter"
import {CrusherDeviceBoxAdapter} from "./devices/audio-effects/CrusherDeviceBoxAdapter"
import {FoldDeviceBoxAdapter} from "./devices/audio-effects/FoldDeviceBoxAdapter"
import {MIDIOutputDeviceBoxAdapter} from "./devices/instruments/MIDIOutputDeviceBoxAdapter"
import {VelocityDeviceBoxAdapter} from "./devices/midi-effects/VelocityDeviceBoxAdapter"
import {TidalDeviceBoxAdapter} from "./devices/audio-effects/TidalDeviceBoxAdapter"
import {DattorroReverbDeviceBoxAdapter} from "./devices/audio-effects/DattorroReverbDeviceBoxAdapter"
import {NeuralAmpDeviceBoxAdapter} from "./devices/audio-effects/NeuralAmpDeviceBoxAdapter"
import {AudioPitchStretchBoxAdapter} from "./audio/AudioPitchStretchBoxAdapter"
import {TransientMarkerBoxAdapter} from "./audio/TransientMarkerBoxAdapter"
import {WarpMarkerBoxAdapter} from "./audio/WarpMarkerBoxAdapter"
import {AudioTimeStretchBoxAdapter} from "./audio/AudioTimeStretchBoxAdapter"
import {SignatureEventBoxAdapter} from "./timeline/SignatureEventBoxAdapter"

export class BoxAdapters implements Terminable {
    readonly #context: BoxAdaptersContext
    readonly #adapters: SortedSet<UUID.Bytes, BoxAdapter>
    readonly #deleted: Set<Box>

    #terminable: Subscription

    constructor(context: BoxAdaptersContext) {
        this.#context = context
        this.#adapters = UUID.newSet<BoxAdapter>(adapter => adapter.uuid)
        this.#deleted = new Set<Box>()

        this.#terminable = this.#context.boxGraph.subscribeToAllUpdates({
            onUpdate: (update: Update) => {
                if (update.type === "delete") {
                    const adapter = this.#adapters.getOrNull(update.uuid)
                    if (isDefined(adapter)) {
                        this.#deleted.add(adapter.box)
                        this.#adapters.removeByValue(adapter).terminate()
                    }
                }
            }
        })
    }

    terminate(): void {
        this.#adapters.values().forEach(adapter => adapter.terminate())
        this.#adapters.clear()
        this.#terminable.terminate()
    }

    adapterFor<BOX extends Box, T extends BoxAdapter>(box: BOX, checkType: Class<T> | AssertType<T>): T {
        if (this.#deleted.has(box)) {
            return panic(`Cannot resolve adapter for already deleted box: ${box}`)
        }
        let adapter = this.#adapters.getOrNull(box.address.uuid)
        if (adapter === null) {
            adapter = this.#create(box)
            const added = this.#adapters.add(adapter)
            assert(added, `Could not add adapter for ${box}`)
        }
        if (typeof checkType === "function") {
            return Object.hasOwn(checkType, "prototype")
                ? adapter instanceof checkType ? adapter as T : panic(`${adapter} is not instance of ${checkType}`)
                : (checkType as AssertType<T>)(adapter) ? adapter as T : panic(`${adapter} did not pass custom type guard`)
        }
        return panic("Unknown checkType method")
    }

    #create(unknownBox: Box): BoxAdapter {
        return asDefined(unknownBox.accept<BoxVisitor<BoxAdapter>>({
            visitArpeggioDeviceBox: (box: ArpeggioDeviceBox) => new ArpeggioDeviceBoxAdapter(this.#context, box),
            visitAudioBusBox: (box: AudioBusBox): BoxAdapter => new AudioBusBoxAdapter(this.#context, box),
            visitAudioClipBox: (box: AudioClipBox) => new AudioClipBoxAdapter(this.#context, box),
            visitAudioFileBox: (box: AudioFileBox) => new AudioFileBoxAdapter(this.#context, box),
            visitAudioTimeStretchBox: (box: AudioTimeStretchBox) => new AudioTimeStretchBoxAdapter(this.#context, box),
            visitAudioPitchStretchBox: (box: AudioPitchStretchBox) => new AudioPitchStretchBoxAdapter(this.#context, box),
            visitTransientMarkerBox: (box: TransientMarkerBox) => new TransientMarkerBoxAdapter(box),
            visitWarpMarkerBox: (box: WarpMarkerBox) => new WarpMarkerBoxAdapter(this.#context, box),
            visitAudioRegionBox: (box: AudioRegionBox) => new AudioRegionBoxAdapter(this.#context, box),
            visitAudioUnitBox: (box: AudioUnitBox) => new AudioUnitBoxAdapter(this.#context, box),
            visitAuxSendBox: (box: AuxSendBox): BoxAdapter => new AuxSendBoxAdapter(this.#context, box),
            visitMaximizerDeviceBox: (box: MaximizerDeviceBox) => new MaximizerDeviceBoxAdapter(this.#context, box),
            visitCompressorDeviceBox: (box: CompressorDeviceBox) => new CompressorDeviceBoxAdapter(this.#context, box),
            visitGateDeviceBox: (box: GateDeviceBox) => new GateDeviceBoxAdapter(this.#context, box),
            visitCrusherDeviceBox: (box: CrusherDeviceBox) => new CrusherDeviceBoxAdapter(this.#context, box),
            visitDattorroReverbDeviceBox: (box: DattorroReverbDeviceBox) => new DattorroReverbDeviceBoxAdapter(this.#context, box),
            visitDelayDeviceBox: (box: DelayDeviceBox) => new DelayDeviceBoxAdapter(this.#context, box),
            visitDeviceInterfaceKnobBox: (box: DeviceInterfaceKnobBox) => new DeviceInterfaceKnobAdapter(this.#context, box),
            visitTidalDeviceBox: (box: TidalDeviceBox) => new TidalDeviceBoxAdapter(this.#context, box),
            visitFoldDeviceBox: (box: FoldDeviceBox) => new FoldDeviceBoxAdapter(this.#context, box),
            visitGrooveShuffleBox: (box: GrooveShuffleBox) => new GrooveShuffleBoxAdapter(this.#context, box),
            visitMarkerBox: (box: MarkerBox) => new MarkerBoxAdapter(this.#context, box),
            visitSignatureEventBox: (box: SignatureEventBox) => new SignatureEventBoxAdapter(this.#context, box),
            visitMIDIOutputDeviceBox: (box: MIDIOutputDeviceBox) => new MIDIOutputDeviceBoxAdapter(this.#context, box),
            visitModularAudioInputBox: (box: ModularAudioInputBox) => new ModularAudioInputAdapter(this.#context, box),
            visitModularAudioOutputBox: (box: ModularAudioOutputBox) => new ModularAudioOutputAdapter(this.#context, box),
            visitModularBox: (box: ModularBox) => new ModularAdapter(this.#context, box),
            visitModularDeviceBox: (box: ModularDeviceBox) => new ModularDeviceBoxAdapter(this.#context, box),
            visitModuleConnectionBox: (box: ModuleConnectionBox) => new ModuleConnectionAdapter(this.#context, box),
            visitModuleDelayBox: (box: ModuleDelayBox) => new ModuleDelayAdapter(this.#context, box),
            visitModuleGainBox: (box: ModuleGainBox) => new ModuleGainAdapter(this.#context, box),
            visitModuleMultiplierBox: (box: ModuleMultiplierBox) => new ModuleMultiplierAdapter(this.#context, box),
            visitNanoDeviceBox: (box: NanoDeviceBox) => new NanoDeviceBoxAdapter(this.#context, box),
            visitNeuralAmpDeviceBox: (box: NeuralAmpDeviceBox) => new NeuralAmpDeviceBoxAdapter(this.#context, box),
            visitNoteClipBox: (box: NoteClipBox) => new NoteClipBoxAdapter(this.#context, box),
            visitNoteEventBox: (box: NoteEventBox) => new NoteEventBoxAdapter(this.#context, box),
            visitNoteEventCollectionBox: (box: NoteEventCollectionBox): BoxAdapter => new NoteEventCollectionBoxAdapter(this.#context, box),
            visitNoteRegionBox: (box: NoteRegionBox) => new NoteRegionBoxAdapter(this.#context, box),
            visitPitchDeviceBox: (box: PitchDeviceBox) => new PitchDeviceBoxAdapter(this.#context, box),
            visitPlayfieldDeviceBox: (box: PlayfieldDeviceBox) => new PlayfieldDeviceBoxAdapter(this.#context, box),
            visitPlayfieldSampleBox: (box: PlayfieldSampleBox) => new PlayfieldSampleBoxAdapter(this.#context, box),
            visitRevampDeviceBox: (box: RevampDeviceBox) => new RevampDeviceBoxAdapter(this.#context, box),
            visitReverbDeviceBox: (box: ReverbDeviceBox) => new ReverbDeviceBoxAdapter(this.#context, box),
            visitRootBox: (box: RootBox): BoxAdapter => new RootBoxAdapter(this.#context, box),
            visitSoundfontDeviceBox: (box: SoundfontDeviceBox) => new SoundfontDeviceBoxAdapter(this.#context, box),
            visitSoundfontFileBox: (box: SoundfontFileBox) => new SoundfontFileBoxAdapter(this.#context, box),
            visitStereoToolDeviceBox: (box: StereoToolDeviceBox) => new StereoToolDeviceBoxAdapter(this.#context, box),
            visitTapeDeviceBox: (box: TapeDeviceBox) => new TapeDeviceBoxAdapter(this.#context, box),
            visitTimelineBox: (box: TimelineBox) => new TimelineBoxAdapter(this.#context, box),
            visitTrackBox: (box: TrackBox) => new TrackBoxAdapter(this.#context, box),
            visitUnknownAudioEffectDeviceBox: (box: UnknownAudioEffectDeviceBox) => new UnknownAudioEffectDeviceBoxAdapter(this.#context, box),
            visitUnknownMidiEffectDeviceBox: (box: UnknownMidiEffectDeviceBox) => new UnknownMidiEffectDeviceBoxAdapter(this.#context, box),
            visitValueClipBox: (box: ValueClipBox) => new ValueClipBoxAdapter(this.#context, box),
            visitValueEventBox: (box: ValueEventBox) => new ValueEventBoxAdapter(this.#context, box),
            visitValueEventCollectionBox: (box: ValueEventCollectionBox): BoxAdapter => new ValueEventCollectionBoxAdapter(this.#context, box),
            visitValueRegionBox: (box: ValueRegionBox) => new ValueRegionBoxAdapter(this.#context, box),
            visitVaporisateurDeviceBox: (box: VaporisateurDeviceBox) => new VaporisateurDeviceBoxAdapter(this.#context, box),
            visitVelocityDeviceBox: (box: VelocityDeviceBox) => new VelocityDeviceBoxAdapter(this.#context, box),
            visitZeitgeistDeviceBox: (box: ZeitgeistDeviceBox) => new ZeitgeistDeviceBoxAdapter(this.#context, box)
        }), `Could not find factory for ${unknownBox}`)
    }
}