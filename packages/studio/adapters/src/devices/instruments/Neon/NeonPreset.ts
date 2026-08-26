import {NeonDeviceBox, NeonEnvelope} from "@opendaw/studio-boxes"
import {Float32Field} from "@opendaw/lib-box"
import {CzEnvelope, CzTone} from "./CzSysex"

// Writes a decoded CZ tone into a NeonDeviceBox (raw hardware values, lossless). Call inside
// `editing.modify` so a preset load is one undoable transaction.
export namespace NeonPreset {
    const rateFields = (envelope: NeonEnvelope): ReadonlyArray<Float32Field> => [
        envelope.rate1, envelope.rate2, envelope.rate3, envelope.rate4,
        envelope.rate5, envelope.rate6, envelope.rate7, envelope.rate8
    ]
    const levelFields = (envelope: NeonEnvelope): ReadonlyArray<Float32Field> => [
        envelope.level1, envelope.level2, envelope.level3, envelope.level4,
        envelope.level5, envelope.level6, envelope.level7, envelope.level8
    ]

    const applyEnvelope = (envelope: NeonEnvelope, source: CzEnvelope): void => {
        rateFields(envelope).forEach((field, index) => field.setValue(source.rates[index] ?? 0))
        levelFields(envelope).forEach((field, index) => field.setValue(source.levels[index] ?? 0))
        envelope.sustain.setValue(source.sustain)
        envelope.end.setValue(source.end)
    }

    export const apply = (box: NeonDeviceBox, tone: CzTone): void => {
        box.lineSelect.setValue(tone.lineSelect)
        box.modulation.setValue(tone.modulation)
        box.octave.setValue(tone.octave)
        // The .syx note+fine pair folds into one cents value (60 fine steps per semitone).
        const cents = tone.detuneNote * 100.0 + tone.detuneFine * (100.0 / 60.0)
        box.detune.setValue(Math.max(-4800.0, Math.min(4800.0, cents)))
        box.vibrato.wave.setValue(tone.vibratoWave)
        box.vibrato.delay.setValue(tone.vibratoDelay)
        box.vibrato.rate.setValue(tone.vibratoRate)
        box.vibrato.depth.setValue(tone.vibratoDepth)
        tone.lines.forEach((line, lineIndex) => {
            const fields = box.lines.fields()[lineIndex]
            fields.wave1.setValue(line.wave1)
            fields.wave2.setValue(line.wave2)
            fields.dcwKeyFollow.setValue(line.dcwKeyFollow)
            fields.dcaKeyFollow.setValue(line.dcaKeyFollow)
            const envelopes = box.envelopes.fields()
            applyEnvelope(envelopes[lineIndex * 3], line.pitchEnv)
            applyEnvelope(envelopes[lineIndex * 3 + 1], line.dcwEnv)
            applyEnvelope(envelopes[lineIndex * 3 + 2], line.dcaEnv)
        })
    }
}
