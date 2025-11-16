import {FieldKey} from "@opendaw/lib-box"
import {Field} from "../Field"
import {Parameter} from "../Parameter"
import {VaporisateurDeviceBox} from "@opendaw/studio-boxes"

export class Vaporisateur implements Field {
    readonly cutoff: Parameter<"float32">
    readonly resonance: Parameter<"float32">
    readonly attack: Parameter<"float32">
    readonly release: Parameter<"float32">
    readonly filterEnvelope: Parameter<"float32">
    readonly decay: Parameter<"float32">
    readonly sustain: Parameter<"float32">
    readonly glideTime: Parameter<"float32">
    readonly voicingMode: Parameter<"int32">
    readonly unisonCount: Parameter<"int32">
    readonly unisonDetune: Parameter<"float32">
    readonly unisonStereo: Parameter<"float32">
    readonly filterOrder: Parameter<"int32">
    readonly filterKeyboard: Parameter<"float32">
    readonly version: Parameter<"int32">
    readonly lfo: {
        waveform: Parameter<"int32">
        rate: Parameter<"float32">
        sync: Parameter<"boolean">
        targetTune: Parameter<"float32">
        targetCutoff: Parameter<"float32">
        targetVolume: Parameter<"float32">
    } & Field
    readonly oscillators: ReadonlyArray<{
        waveform: Parameter<"int32">
        volume: Parameter<"float32">
        octave: Parameter<"int32">
        tune: Parameter<"float32">
    } & Field> & Field
    readonly noise: {
        attack: Parameter<"float32">
        hold: Parameter<"float32">
        release: Parameter<"float32">
        volume: Parameter<"float32">
    } & Field
    constructor() {
        this.cutoff = new Parameter(this, 14, "float32", 0)
        this.resonance = new Parameter(this, 15, "float32", 0)
        this.attack = new Parameter(this, 16, "float32", 0)
        this.release = new Parameter(this, 17, "float32", 0)
        this.filterEnvelope = new Parameter(this, 18, "float32", 0)
        this.decay = new Parameter(this, 19, "float32", 0.001)
        this.sustain = new Parameter(this, 20, "float32", 1.0)
        this.glideTime = new Parameter(this, 21, "float32", 0.0)
        this.voicingMode = new Parameter(this, 22, "int32", 0) // VoicingMode.Polyphonic
        this.unisonCount = new Parameter(this, 23, "int32", 1)
        this.unisonDetune = new Parameter(this, 24, "float32", 30)
        this.unisonStereo = new Parameter(this, 25, "float32", 1.0)
        this.filterOrder = new Parameter(this, 26, "int32", 1)
        this.filterKeyboard = new Parameter(this, 27, "float32", 0)
        this.version = new Parameter(this, 99, "int32", 0)
        this.lfo = Field.object(this, 30, (self) => ({
            waveform: new Parameter(self, 1, "int32", 0),
            rate: new Parameter(self, 2, "float32", 0),
            sync: new Parameter(self, 3, "boolean", false),
            targetTune: new Parameter(self, 10, "float32", 0),
            targetCutoff: new Parameter(self, 11, "float32", 0),
            targetVolume: new Parameter(self, 12, "float32", 0)
        }))
        this.oscillators = Field.array(this, 40, 2, (self, index) =>
            Field.object(self, index, (oscSelf) => ({
                waveform: new Parameter(oscSelf, 1, "int32", 0),
                volume: new Parameter(oscSelf, 2, "float32", Number.NEGATIVE_INFINITY),
                octave: new Parameter(oscSelf, 3, "int32", 0),
                tune: new Parameter(oscSelf, 4, "float32", 0)
            }))
        )
        this.noise = Field.object(this, 50, (self) => ({
            attack: new Parameter(self, 1, "float32", 0.001),
            hold: new Parameter(self, 2, "float32", 0.001),
            release: new Parameter(self, 3, "float32", 0.001),
            volume: new Parameter(self, 4, "float32", 0.001)
        }))
    }

    get path(): FieldKey[] {return []}

    readFrom(box: VaporisateurDeviceBox): void {
        this.cutoff.set(box.cutoff.getValue())
        this.resonance.set(box.resonance.getValue())
        this.attack.set(box.attack.getValue())
        this.release.set(box.release.getValue())
        this.filterEnvelope.set(box.filterEnvelope.getValue())
        this.decay.set(box.decay.getValue())
        this.sustain.set(box.sustain.getValue())
        this.glideTime.set(box.glideTime.getValue())
        this.voicingMode.set(box.voicingMode.getValue())
        this.unisonCount.set(box.unisonCount.getValue())
        this.unisonDetune.set(box.unisonDetune.getValue())
        this.unisonStereo.set(box.unisonStereo.getValue())
        this.filterOrder.set(box.filterOrder.getValue())
        this.filterKeyboard.set(box.filterKeyboard.getValue())
        this.version.set(box.version.getValue())
        this.lfo.waveform.set(box.lfo.waveform.getValue())
        this.lfo.rate.set(box.lfo.rate.getValue())
        this.lfo.sync.set(box.lfo.sync.getValue())
        this.lfo.targetTune.set(box.lfo.targetTune.getValue())
        this.lfo.targetCutoff.set(box.lfo.targetCutoff.getValue())
        this.lfo.targetVolume.set(box.lfo.targetVolume.getValue())
        for (let i = 0; i < this.oscillators.length; i++) {
            const boxFields = box.oscillators.fields()
            const oscillator = this.oscillators[i]
            oscillator.waveform.set(boxFields[i].waveform.getValue())
            oscillator.volume.set(boxFields[i].volume.getValue())
            oscillator.octave.set(boxFields[i].octave.getValue())
            oscillator.tune.set(boxFields[i].tune.getValue())
        }
        this.noise.attack.set(box.noise.attack.getValue())
        this.noise.hold.set(box.noise.hold.getValue())
        this.noise.release.set(box.noise.release.getValue())
        this.noise.volume.set(box.noise.volume.getValue())
    }

    writeTo(box: VaporisateurDeviceBox): void {
        box.cutoff.setValue(this.cutoff.get())
        box.resonance.setValue(this.resonance.get())
        box.attack.setValue(this.attack.get())
        box.release.setValue(this.release.get())
        box.filterEnvelope.setValue(this.filterEnvelope.get())
        box.decay.setValue(this.decay.get())
        box.sustain.setValue(this.sustain.get())
        box.glideTime.setValue(this.glideTime.get())
        box.voicingMode.setValue(this.voicingMode.get())
        box.unisonCount.setValue(this.unisonCount.get())
        box.unisonDetune.setValue(this.unisonDetune.get())
        box.unisonStereo.setValue(this.unisonStereo.get())
        box.filterOrder.setValue(this.filterOrder.get())
        box.filterKeyboard.setValue(this.filterKeyboard.get())
        box.version.setValue(this.version.get())
        box.lfo.waveform.setValue(this.lfo.waveform.get())
        box.lfo.rate.setValue(this.lfo.rate.get())
        box.lfo.sync.setValue(this.lfo.sync.get())
        box.lfo.targetTune.setValue(this.lfo.targetTune.get())
        box.lfo.targetCutoff.setValue(this.lfo.targetCutoff.get())
        box.lfo.targetVolume.setValue(this.lfo.targetVolume.get())
        for (let i = 0; i < this.oscillators.length; i++) {
            const boxFields = box.oscillators.fields()
            const oscillator = this.oscillators[i]
            boxFields[i].waveform.setValue(oscillator.waveform.get())
            boxFields[i].volume.setValue(oscillator.volume.get())
            boxFields[i].octave.setValue(oscillator.octave.get())
            boxFields[i].tune.setValue(oscillator.tune.get())
        }
        box.noise.attack.setValue(this.noise.attack.get())
        box.noise.hold.setValue(this.noise.hold.get())
        box.noise.release.setValue(this.noise.release.get())
        box.noise.volume.setValue(this.noise.volume.get())
    }
}