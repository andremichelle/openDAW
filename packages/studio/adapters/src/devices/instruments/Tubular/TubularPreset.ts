import {TubularDeviceBox, TubularOperator} from "@opendaw/studio-boxes"
import {Int32Field} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {Dx7Sysex} from "./Dx7Sysex"

type VoiceField = Int32Field<Pointers.Automation | Pointers.MIDIControl | Pointers.Modulation>

// Moves a 155-byte DX7 voice into and out of a TubularDeviceBox. Box operators are OP1..OP6 (panel order),
// the voice stores OP6 first. Call `apply` inside `editing.modify` so a load is one undoable transaction.
export namespace TubularPreset {
    const operatorFields = (operator: TubularOperator): ReadonlyArray<VoiceField> => [
        operator.rate1, operator.rate2, operator.rate3, operator.rate4,
        operator.level1, operator.level2, operator.level3, operator.level4,
        operator.breakPoint, operator.leftDepth, operator.rightDepth, operator.leftCurve, operator.rightCurve,
        operator.rateScaling, operator.ampModSens, operator.velocitySens, operator.outputLevel,
        operator.mode, operator.coarse, operator.fine, operator.detune
    ]

    const globalFields = (box: TubularDeviceBox): ReadonlyArray<VoiceField> => [
        box.pitchEnvelope.rate1, box.pitchEnvelope.rate2, box.pitchEnvelope.rate3, box.pitchEnvelope.rate4,
        box.pitchEnvelope.level1, box.pitchEnvelope.level2, box.pitchEnvelope.level3, box.pitchEnvelope.level4,
        box.algorithm, box.feedback, box.oscKeySync,
        box.lfo.speed, box.lfo.delay, box.lfo.pmDepth, box.lfo.amDepth, box.lfo.sync, box.lfo.wave,
        box.pitchModSens, box.transpose
    ]

    export const apply = (box: TubularDeviceBox, voice: Uint8Array): void => {
        box.operators.fields().forEach((operator, index) => {
            const offset = (5 - index) * 21
            operatorFields(operator).forEach((field, key) => field.setValue(voice[offset + key]))
            operator.enabled.setValue(1)
        })
        globalFields(box).forEach((field, index) => field.setValue(voice[126 + index]))
        box.label.setValue(Dx7Sysex.voiceName(voice))
        box.voiceLoad.setValue(box.voiceLoad.getValue() + 1)
    }

    export const read = (box: TubularDeviceBox): Uint8Array => {
        const voice = new Uint8Array(Dx7Sysex.PATCH_SIZE)
        box.operators.fields().forEach((operator, index) => {
            const offset = (5 - index) * 21
            operatorFields(operator).forEach((field, key) => voice[offset + key] = field.getValue())
        })
        globalFields(box).forEach((field, index) => voice[126 + index] = field.getValue())
        return Dx7Sysex.withName(voice, box.label.getValue())
    }
}
