import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {
    ArpeggioDeviceBox,
    AudioBusBox,
    BoxVisitor,
    BrickDeviceBox,
    CompressorDeviceBox,
    CrusherDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    FoldDeviceBox,
    MIDIOutputDeviceBox,
    ModularDeviceBox,
    NanoDeviceBox,
    PitchDeviceBox,
    PlayfieldDeviceBox,
    PlayfieldSampleBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    SoundfontDeviceBox,
    StereoToolDeviceBox,
    TapeDeviceBox,
    TidalDeviceBox,
    UnknownAudioEffectDeviceBox,
    UnknownMidiEffectDeviceBox,
    VaporisateurDeviceBox,
    VelocityDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {ArpeggioDeviceEditor} from "@/ui/devices/midi-effects/ArpeggioDeviceEditor.tsx"
import {
    ArpeggioDeviceBoxAdapter,
    AudioBusBoxAdapter,
    BrickDeviceBoxAdapter,
    CompressorDeviceBoxAdapter,
    CrusherDeviceBoxAdapter,
    DattorroReverbDeviceBoxAdapter,
    DelayDeviceBoxAdapter,
    DeviceHost,
    FoldDeviceBoxAdapter,
    MIDIOutputDeviceBoxAdapter,
    ModularDeviceBoxAdapter,
    NanoDeviceBoxAdapter,
    PitchDeviceBoxAdapter,
    PlayfieldDeviceBoxAdapter,
    PlayfieldSampleBoxAdapter,
    RevampDeviceBoxAdapter,
    ReverbDeviceBoxAdapter,
    SoundfontDeviceBoxAdapter,
    StereoToolDeviceBoxAdapter,
    TapeDeviceBoxAdapter,
    TidalDeviceBoxAdapter,
    UnknownAudioEffectDeviceBoxAdapter,
    UnknownMidiEffectDeviceBoxAdapter,
    VaporisateurDeviceBoxAdapter,
    VelocityDeviceBoxAdapter,
    ZeitgeistDeviceBoxAdapter
} from "@opendaw/studio-adapters"
import {DelayDeviceEditor} from "@/ui/devices/audio-effects/DelayDeviceEditor.tsx"
import {ReverbDeviceEditor} from "@/ui/devices/audio-effects/ReverbDeviceEditor.tsx"
import {RevampDeviceEditor} from "@/ui/devices/audio-effects/RevampDeviceEditor.tsx"
import {ModularDeviceEditor} from "@/ui/devices/audio-effects/ModularDeviceEditor.tsx"
import {asDefined, Lifecycle} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {PitchDeviceEditor} from "./midi-effects/PitchDeviceEditor"
import {TapeDeviceEditor} from "@/ui/devices/instruments/TapeDeviceEditor.tsx"
import {VaporisateurDeviceEditor} from "@/ui/devices/instruments/VaporisateurDeviceEditor.tsx"
import {AudioBusEditor} from "@/ui/devices/AudioBusEditor.tsx"
import {NanoDeviceEditor} from "./instruments/NanoDeviceEditor"
import {PlayfieldDeviceEditor} from "./instruments/PlayfieldDeviceEditor"
import {StereoToolDeviceEditor} from "./audio-effects/StereoToolDeviceEditor"
import {PlayfieldSampleEditor} from "./instruments/PlayfieldSampleEditor"
import {ZeitgeistDeviceEditor} from "@/ui/devices/midi-effects/ZeitgeistDeviceEditor"
import {UnknownEffectDeviceEditor} from "@/ui/devices/UnknownEffectDeviceEditor"
import {StudioService} from "@/service/StudioService"
import {SoundfontDeviceEditor} from "@/ui/devices/instruments/SoundfontDeviceEditor"
import {BrickDeviceEditor} from "@/ui/devices/audio-effects/BrickDeviceEditor"
import {CompressorDeviceEditor} from "@/ui/devices/audio-effects/CompressorDeviceEditor"
import {CrusherDeviceEditor} from "@/ui/devices/audio-effects/CrusherDeviceEditor"
import {FoldDeviceEditor} from "@/ui/devices/audio-effects/FoldDeviceEditor"
import {MIDIOutputDeviceEditor} from "@/ui/devices/instruments/MIDIOutputDeviceEditor"
import {VelocityDeviceEditor} from "@/ui/devices/midi-effects/VelocityDeviceEditor"
import {TidalDeviceEditor} from "@/ui/devices/audio-effects/TidalDeviceEditor"
import {DattorroReverbDeviceEditor} from "@/ui/devices/audio-effects/DattorroReverbDeviceEditor"

export namespace DeviceEditorFactory {
    export const toMidiEffectDeviceEditor = (service: StudioService, lifecycle: Lifecycle, box: Box, deviceHost: DeviceHost) =>
        asDefined(box.accept<BoxVisitor<JsxValue>>({
            visitUnknownMidiEffectDeviceBox: (box: UnknownMidiEffectDeviceBox) => (
                <UnknownEffectDeviceEditor lifecycle={lifecycle}
                                           service={service}
                                           adapter={service.project.boxAdapters
                                               .adapterFor(box, UnknownMidiEffectDeviceBoxAdapter)}
                                           deviceHost={deviceHost}/>
            ),
            visitArpeggioDeviceBox: (box: ArpeggioDeviceBox) => (
                <ArpeggioDeviceEditor lifecycle={lifecycle}
                                      service={service}
                                      adapter={service.project.boxAdapters.adapterFor(box, ArpeggioDeviceBoxAdapter)}
                                      deviceHost={deviceHost}/>
            ),
            visitPitchDeviceBox: (box: PitchDeviceBox) => (
                <PitchDeviceEditor lifecycle={lifecycle}
                                   service={service}
                                   adapter={service.project.boxAdapters.adapterFor(box, PitchDeviceBoxAdapter)}
                                   deviceHost={deviceHost}/>
            ),
            visitVelocityDeviceBox: (box: VelocityDeviceBox) => (
                <VelocityDeviceEditor lifecycle={lifecycle}
                                      service={service}
                                      adapter={service.project.boxAdapters.adapterFor(box, VelocityDeviceBoxAdapter)}
                                      deviceHost={deviceHost}/>
            ),
            visitZeitgeistDeviceBox: (box: ZeitgeistDeviceBox) => (
                <ZeitgeistDeviceEditor lifecycle={lifecycle}
                                       service={service}
                                       adapter={service.project.boxAdapters.adapterFor(box, ZeitgeistDeviceBoxAdapter)}
                                       deviceHost={deviceHost}/>
            )
        }), `No MidiEffectDeviceEditor found for ${box}`)

    export const toInstrumentDeviceEditor = (service: StudioService,
                                             lifecycle: Lifecycle,
                                             box: Box,
                                             deviceHost: DeviceHost) =>
        asDefined(box.accept<BoxVisitor<JsxValue>>({
            visitTapeDeviceBox: (box: TapeDeviceBox): JsxValue => (
                <TapeDeviceEditor lifecycle={lifecycle}
                                  service={service}
                                  adapter={service.project.boxAdapters.adapterFor(box, TapeDeviceBoxAdapter)}
                                  deviceHost={deviceHost}/>
            ),
            visitVaporisateurDeviceBox: (box: VaporisateurDeviceBox): JsxValue => (
                <VaporisateurDeviceEditor lifecycle={lifecycle}
                                          service={service}
                                          adapter={service.project.boxAdapters.adapterFor(box, VaporisateurDeviceBoxAdapter)}
                                          deviceHost={deviceHost}/>
            ),
            visitMIDIOutputDeviceBox: (box: MIDIOutputDeviceBox): JsxValue => (
                <MIDIOutputDeviceEditor lifecycle={lifecycle}
                                        service={service}
                                        adapter={service.project.boxAdapters.adapterFor(box, MIDIOutputDeviceBoxAdapter)}
                                        deviceHost={deviceHost}/>
            ),
            visitSoundfontDeviceBox: (box: SoundfontDeviceBox): JsxValue => (
                <SoundfontDeviceEditor lifecycle={lifecycle}
                                       service={service}
                                       adapter={service.project.boxAdapters.adapterFor(box, SoundfontDeviceBoxAdapter)}
                                       deviceHost={deviceHost}/>
            ),
            visitNanoDeviceBox: (box: NanoDeviceBox): JsxValue => (
                <NanoDeviceEditor lifecycle={lifecycle}
                                  service={service}
                                  adapter={service.project.boxAdapters.adapterFor(box, NanoDeviceBoxAdapter)}
                                  deviceHost={deviceHost}/>
            ),
            visitPlayfieldDeviceBox: (box: PlayfieldDeviceBox): JsxValue => (
                <PlayfieldDeviceEditor lifecycle={lifecycle}
                                       service={service}
                                       adapter={service.project.boxAdapters.adapterFor(box, PlayfieldDeviceBoxAdapter)}
                                       deviceHost={deviceHost}/>
            ),
            visitPlayfieldSampleBox: (box: PlayfieldSampleBox): JsxValue => (
                <PlayfieldSampleEditor lifecycle={lifecycle}
                                       service={service}
                                       adapter={service.project.boxAdapters.adapterFor(box, PlayfieldSampleBoxAdapter)}
                                       deviceHost={deviceHost}/>
            ),
            visitAudioBusBox: (box: AudioBusBox): JsxValue => (
                <AudioBusEditor lifecycle={lifecycle}
                                service={service}
                                adapter={service.project.boxAdapters.adapterFor(box, AudioBusBoxAdapter)}/>
            )
        }), `No MidiEffectDeviceEditor found for ${box}`)

    export const toAudioEffectDeviceEditor = (service: StudioService, lifecycle: Lifecycle, box: Box, deviceHost: DeviceHost) =>
        asDefined(box.accept<BoxVisitor<JsxValue>>({
            visitUnknownAudioEffectDeviceBox: (box: UnknownAudioEffectDeviceBox) => (
                <UnknownEffectDeviceEditor lifecycle={lifecycle}
                                           service={service}
                                           adapter={service.project.boxAdapters
                                               .adapterFor(box, UnknownAudioEffectDeviceBoxAdapter)}
                                           deviceHost={deviceHost}/>
            ),
            visitStereoToolDeviceBox: (box: StereoToolDeviceBox) => (
                <StereoToolDeviceEditor lifecycle={lifecycle}
                                        service={service}
                                        adapter={service.project.boxAdapters.adapterFor(box, StereoToolDeviceBoxAdapter)}
                                        deviceHost={deviceHost}/>
            ),
            visitBrickDeviceBox: (box: BrickDeviceBox) => (
                <BrickDeviceEditor lifecycle={lifecycle}
                                   service={service}
                                   adapter={service.project.boxAdapters.adapterFor(box, BrickDeviceBoxAdapter)}
                                   deviceHost={deviceHost}/>
            ),
            visitDelayDeviceBox: (box: DelayDeviceBox) => (
                <DelayDeviceEditor lifecycle={lifecycle}
                                   service={service}
                                   adapter={service.project.boxAdapters.adapterFor(box, DelayDeviceBoxAdapter)}
                                   deviceHost={deviceHost}/>
            ),
            visitDattorroReverbDeviceBox: (box: DattorroReverbDeviceBox) => (
                <DattorroReverbDeviceEditor lifecycle={lifecycle}
                                            service={service}
                                            adapter={service.project.boxAdapters.adapterFor(box, DattorroReverbDeviceBoxAdapter)}
                                            deviceHost={deviceHost}/>
            ),
            visitTidalDeviceBox: (box: TidalDeviceBox) => (
                <TidalDeviceEditor lifecycle={lifecycle}
                                   service={service}
                                   adapter={service.project.boxAdapters.adapterFor(box, TidalDeviceBoxAdapter)}
                                   deviceHost={deviceHost}/>
            ),
            visitCrusherDeviceBox: (box: CrusherDeviceBox) => (
                <CrusherDeviceEditor lifecycle={lifecycle}
                                     service={service}
                                     adapter={service.project.boxAdapters.adapterFor(box, CrusherDeviceBoxAdapter)}
                                     deviceHost={deviceHost}/>
            ),
            visitFoldDeviceBox: (box: FoldDeviceBox) => (
                <FoldDeviceEditor lifecycle={lifecycle}
                                  service={service}
                                  adapter={service.project.boxAdapters.adapterFor(box, FoldDeviceBoxAdapter)}
                                  deviceHost={deviceHost}/>
            ),
            visitCompressorDeviceBox: (box: CompressorDeviceBox) => (
                <CompressorDeviceEditor lifecycle={lifecycle}
                                        service={service}
                                        adapter={service.project.boxAdapters.adapterFor(box, CompressorDeviceBoxAdapter)}
                                        deviceHost={deviceHost}/>
            ),
            visitReverbDeviceBox: (box: ReverbDeviceBox) => (
                <ReverbDeviceEditor lifecycle={lifecycle}
                                    service={service}
                                    adapter={service.project.boxAdapters.adapterFor(box, ReverbDeviceBoxAdapter)}
                                    deviceHost={deviceHost}/>
            ),
            visitRevampDeviceBox: (box: RevampDeviceBox) => (
                <RevampDeviceEditor lifecycle={lifecycle}
                                    service={service}
                                    adapter={service.project.boxAdapters.adapterFor(box, RevampDeviceBoxAdapter)}
                                    deviceHost={deviceHost}/>
            ),
            visitModularDeviceBox: (box: ModularDeviceBox) => (
                <ModularDeviceEditor lifecycle={lifecycle}
                                     service={service}
                                     adapter={service.project.boxAdapters.adapterFor(box, ModularDeviceBoxAdapter)}
                                     deviceHost={deviceHost}/>
            )
        }), `No AudioEffectDeviceEditor found for ${box}`)
}