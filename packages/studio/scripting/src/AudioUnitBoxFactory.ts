import {asDefined, int, isDefined, isNotNull, Option, Procedure, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {AudioUnitType, IconSymbol} from "@opendaw/studio-enums"
import {AudioBusBox, AudioUnitBox, AuxSendBox, TrackBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {AudioUnitFactory, CaptureBox, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AuxAudioUnitImpl, GroupAudioUnitImpl, InstrumentAudioUnitImpl, ProjectImpl, SendImpl} from "./impl"
import {MIDIEffectFactory} from "./MIDIEffectFactory"
import {AudioEffectFactory} from "./AudioEffectFactory"
import {NoteTrackWriter} from "./NoteTrackWriter"
import {ValueTrackWriter} from "./ValueTrackWriter"
import {AnyDevice, AudioUnit, Nano, Vaporisateur} from "./Api"
import {AudioTrackWriter} from "./AudioTrackWriter"
import {AudioFileBoxfactory} from "./AudioFileBoxfactory"

export namespace AudioUnitBoxFactory {
    export const create = (skeleton: ProjectSkeleton, project: ProjectImpl): void => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox, primaryAudioUnitBox}} = skeleton
        let audioUnitIndex: int = 0
        const devices: Map<AnyDevice, Box> = new Map()
        const busMap: Map<AudioUnit, AudioBusBox> = new Map([[project.output, primaryAudioBusBox]])
        const audioUnitMap: Map<AudioUnit, AudioUnitBox> = new Map([[project.output, primaryAudioUnitBox]])
        const awaitedSends: Array<[SendImpl, AuxSendBox]> = []
        const noteTrackWriter = new NoteTrackWriter()
        const valueTrackWriter = new ValueTrackWriter()
        const createSend = (sends: ReadonlyArray<SendImpl>, audioUnitBox: AudioUnitBox) => {
            awaitedSends.push(...(sends.map((send: SendImpl, index: int): [SendImpl, AuxSendBox] =>
                [send, AuxSendBox.create(boxGraph, UUID.generate(), box => {
                    box.index.setValue(index)
                    box.audioUnit.refer(audioUnitBox.auxSends)
                    box.sendGain.setValue(send.amount)
                    box.sendPan.setValue(send.pan)
                    // TODO mode "pre" | "post"
                })])))
        }
        project.instrumentUnits.forEach((audioUnit: InstrumentAudioUnitImpl) => {
            const {
                instrument, midiEffects, audioEffects, noteTracks, audioTracks, valueTracks,
                volume, panning, mute, solo, sends
            } = audioUnit
            const factory = InstrumentFactories.Named[instrument.name]
            const capture: Option<CaptureBox> = AudioUnitFactory.trackTypeToCapture(boxGraph, factory.trackType)
            const audioUnitBox = AudioUnitFactory.create(skeleton, AudioUnitType.Instrument, capture)
            devices.set(audioUnit, audioUnitBox)
            audioUnitBox.index.setValue(audioUnitIndex++)
            audioUnitBox.mute.setValue(mute)
            audioUnitBox.solo.setValue(solo)
            audioUnitBox.volume.setValue(volume)
            audioUnitBox.panning.setValue(panning)
            if (factory === InstrumentFactories.Nano) {
                const constructorFn = instrument.constructorFn as Procedure<Nano> | undefined
                let sample: Nano["sample"] | undefined
                if (isDefined(constructorFn)) {
                    const wrapper = {sample: undefined as Nano["sample"] | undefined} as Nano
                    constructorFn(wrapper)
                    sample = wrapper.sample
                }
                factory.create(boxGraph, audioUnitBox.input, factory.defaultName, factory.defaultIcon,
                    isDefined(sample) ? AudioFileBoxfactory.create(boxGraph, sample) : undefined)
            } else if (factory === InstrumentFactories.Vaporisateur) {
                const deviceBox = factory.create(boxGraph, audioUnitBox.input, factory.defaultName, factory.defaultIcon)
                const constructorFn = instrument.constructorFn as Procedure<Vaporisateur> | undefined
                if (isDefined(constructorFn)) {
                    constructorFn(createVaporisateurWrapper(deviceBox))
                }
            } else {
                factory.create(boxGraph, audioUnitBox.input, factory.defaultName, factory.defaultIcon)
            }
            midiEffects.forEach((effect) => devices.set(effect, MIDIEffectFactory.write(boxGraph, audioUnitBox, effect)))
            audioEffects.forEach((effect) => devices.set(effect, AudioEffectFactory.write(boxGraph, audioUnitBox, effect)))
            const indexRef = {index: 0}
            noteTrackWriter.write(boxGraph, audioUnitBox, noteTracks, indexRef)
            valueTrackWriter.write(boxGraph, devices, audioUnitBox, valueTracks, indexRef)
            AudioTrackWriter.write(boxGraph, audioUnitBox, audioTracks, indexRef)
            if (indexRef.index === 0) { // create a default track if none existed
                TrackBox.create(boxGraph, UUID.generate(), box => {
                    box.type.setValue(factory.trackType)
                    box.index.setValue(0)
                    box.target.refer(audioUnitBox)
                    box.tracks.refer(audioUnitBox.tracks)
                })
            }
            createSend(sends, audioUnitBox)
            audioUnitMap.set(audioUnit, audioUnitBox)
        })
        const convertBusUnits = (audioUnit: GroupAudioUnitImpl | AuxAudioUnitImpl,
                                 type: string, icon: IconSymbol, color: string) => {
            const audioBusBox = AudioBusBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(rootBox.audioBusses)
                box.label.setValue(audioUnit.label)
                box.icon.setValue(IconSymbol.toName(icon))
                box.color.setValue(color)
            })
            const audioUnitBox = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
                box.type.setValue(type)
                box.collection.refer(rootBox.audioUnits)
                box.index.setValue(audioUnitIndex++)
            })
            busMap.set(audioUnit, audioBusBox)
            audioUnitMap.set(audioUnit, audioUnitBox)
            audioBusBox.output.refer(audioUnitBox.input)
            createSend(audioUnit.sends, audioUnitBox)
            devices.set(audioUnit, audioUnitBox)
            audioUnit.audioEffects.forEach((effect) =>
                devices.set(effect, AudioEffectFactory.write(boxGraph, audioUnitBox, effect)))
            valueTrackWriter.write(boxGraph, devices, audioUnitBox, audioUnit.valueTracks, {index: 0})
        }

        // TODO Colors need to be in code and written to CSS
        // Then use ColorCodes!
        project.auxUnits.forEach(unit => convertBusUnits(
            unit, AudioUnitType.Aux, IconSymbol.Flask, "var(--color-orange)"))
        project.groupUnits.forEach(unit => convertBusUnits(
            unit, AudioUnitType.Bus, IconSymbol.AudioBus, "var(--color-blue)"))

        awaitedSends.forEach(([send, box]) =>
            box.targetBus.refer(asDefined(busMap.get(send.target), "Could not find AudioBus").input))

        const {output: {mute, solo, volume, panning}} = project
        primaryAudioUnitBox.mute.setValue(mute)
        primaryAudioUnitBox.solo.setValue(solo)
        primaryAudioUnitBox.volume.setValue(volume)
        primaryAudioUnitBox.panning.setValue(panning)
        primaryAudioUnitBox.index.setValue(audioUnitIndex)

        // connect
        const audioUnits: ReadonlyArray<AudioUnit> = [
            ...project.instrumentUnits,
            ...project.auxUnits,
            ...project.groupUnits
        ]
        audioUnits.forEach((audioUnit: AudioUnit) => {
            const {output} = audioUnit
            // undefined means we connect this to the primary output
            // null means this is intended to be unplugged
            const audioBusBox = output === undefined
                ? primaryAudioBusBox : output === null
                    ? null : asDefined(busMap.get(output), "Could not find AudioBus")
            if (isNotNull(audioBusBox)) {
                const audioUnitBox = asDefined(audioUnitMap.get(audioUnit), "audio unit not found in map")
                audioUnitBox.output.refer(audioBusBox.input)
            }
        })
    }

    const createVaporisateurWrapper = (box: VaporisateurDeviceBox): Vaporisateur => {
        const oscFields = box.oscillators.fields()
        return {
            // Instrument base (readonly, not used in constructor)
            get audioUnit() {return undefined as any},
            // Filter
            get cutoff() {return box.cutoff.getValue()},
            set cutoff(v) {box.cutoff.setValue(v)},
            get resonance() {return box.resonance.getValue()},
            set resonance(v) {box.resonance.setValue(v)},
            get filterOrder() {return box.filterOrder.getValue() as 1 | 2 | 3 | 4},
            set filterOrder(v) {box.filterOrder.setValue(v)},
            get filterEnvelope() {return box.filterEnvelope.getValue()},
            set filterEnvelope(v) {box.filterEnvelope.setValue(v)},
            get filterKeyboard() {return box.filterKeyboard.getValue()},
            set filterKeyboard(v) {box.filterKeyboard.setValue(v)},
            // Envelope
            get attack() {return box.attack.getValue()},
            set attack(v) {box.attack.setValue(v)},
            get decay() {return box.decay.getValue()},
            set decay(v) {box.decay.setValue(v)},
            get sustain() {return box.sustain.getValue()},
            set sustain(v) {box.sustain.setValue(v)},
            get release() {return box.release.getValue()},
            set release(v) {box.release.setValue(v)},
            // Voice
            get voicingMode() {return box.voicingMode.getValue()},
            set voicingMode(v) {box.voicingMode.setValue(v)},
            get glideTime() {return box.glideTime.getValue()},
            set glideTime(v) {box.glideTime.setValue(v)},
            // Unison
            get unisonCount() {return box.unisonCount.getValue() as 1 | 3 | 5},
            set unisonCount(v) {box.unisonCount.setValue(v)},
            get unisonDetune() {return box.unisonDetune.getValue()},
            set unisonDetune(v) {box.unisonDetune.setValue(v)},
            get unisonStereo() {return box.unisonStereo.getValue()},
            set unisonStereo(v) {box.unisonStereo.setValue(v)},
            // LFO
            lfo: {
                get waveform() {return box.lfo.waveform.getValue()},
                set waveform(v) {box.lfo.waveform.setValue(v)},
                get rate() {return box.lfo.rate.getValue()},
                set rate(v) {box.lfo.rate.setValue(v)},
                get sync() {return box.lfo.sync.getValue()},
                set sync(v) {box.lfo.sync.setValue(v)},
                get targetTune() {return box.lfo.targetTune.getValue()},
                set targetTune(v) {box.lfo.targetTune.setValue(v)},
                get targetCutoff() {return box.lfo.targetCutoff.getValue()},
                set targetCutoff(v) {box.lfo.targetCutoff.setValue(v)},
                get targetVolume() {return box.lfo.targetVolume.getValue()},
                set targetVolume(v) {box.lfo.targetVolume.setValue(v)}
            },
            // Oscillators
            oscillators: [
                {
                    get waveform() {return oscFields[0].waveform.getValue()},
                    set waveform(v) {oscFields[0].waveform.setValue(v)},
                    get volume() {return oscFields[0].volume.getValue()},
                    set volume(v) {oscFields[0].volume.setValue(v)},
                    get octave() {return oscFields[0].octave.getValue()},
                    set octave(v) {oscFields[0].octave.setValue(v)},
                    get tune() {return oscFields[0].tune.getValue()},
                    set tune(v) {oscFields[0].tune.setValue(v)}
                },
                {
                    get waveform() {return oscFields[1].waveform.getValue()},
                    set waveform(v) {oscFields[1].waveform.setValue(v)},
                    get volume() {return oscFields[1].volume.getValue()},
                    set volume(v) {oscFields[1].volume.setValue(v)},
                    get octave() {return oscFields[1].octave.getValue()},
                    set octave(v) {oscFields[1].octave.setValue(v)},
                    get tune() {return oscFields[1].tune.getValue()},
                    set tune(v) {oscFields[1].tune.setValue(v)}
                }
            ],
            // Noise
            noise: {
                get attack() {return box.noise.attack.getValue()},
                set attack(v) {box.noise.attack.setValue(v)},
                get hold() {return box.noise.hold.getValue()},
                set hold(v) {box.noise.hold.setValue(v)},
                get release() {return box.noise.release.getValue()},
                set release(v) {box.noise.release.setValue(v)},
                get volume() {return box.noise.volume.getValue()},
                set volume(v) {box.noise.volume.setValue(v)}
            }
        }
    }
}