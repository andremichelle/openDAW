import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {TubularDeviceBox, TubularOperator} from "@opendaw/studio-boxes"
import {Address, BooleanField, Int32Field, StringField} from "@opendaw/lib-box"
import {Pointers, VoicingMode} from "@opendaw/studio-enums"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export namespace Tubular {
    export const Algorithms = Array.from({length: 32}, (_, index) => String(index + 1))
    export const Curves = ["-LIN", "-EXP", "+EXP", "+LIN"]
    export const Modes = ["Ratio", "Fixed"]
    export const Detunes = Array.from({length: 15}, (_, index) => index === 7 ? "0" : index > 7 ? `+${index - 7}` : String(index - 7))
    export const LfoWaves = ["Triangle", "Saw Down", "Saw Up", "Square", "Sine", "S&H"]
    export const Switch = ["Off", "On"]
    // Transpose 0..48 around 24 = C3 (the DX7 panel's key display)
    export const Transposes = Array.from({length: 49}, (_, index) => {
        const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
        return `${names[index % 12]}${Math.floor(index / 12) + 1}`
    })
}

type ParameterField = Int32Field<Pointers.Automation | Pointers.MIDIControl | Pointers.Modulation>

export class TubularDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Tubular

    readonly #context: BoxAdaptersContext
    readonly #box: TubularDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: TubularDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): TubularDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: TubularDeviceBox) {
        const VoiceModes = [VoicingMode.Monophonic, VoicingMode.Polyphonic]
        const byte = (field: ParameterField, max: number, name: string) =>
            this.#parametric.createParameter(field, ValueMapping.linearInteger(0, max),
                StringMapping.numeric({unit: "", fractionDigits: 0}), name)
        const choice = (field: ParameterField, labels: ReadonlyArray<string>, name: string) =>
            this.#parametric.createParameter(field, ValueMapping.linearInteger(0, labels.length - 1),
                StringMapping.indices("", labels), name)
        const operator = (fields: TubularOperator, index: number) => {
            const prefix = `OP${index + 1}`
            return {
                rate1: byte(fields.rate1, 99, `${prefix} Rate 1`),
                rate2: byte(fields.rate2, 99, `${prefix} Rate 2`),
                rate3: byte(fields.rate3, 99, `${prefix} Rate 3`),
                rate4: byte(fields.rate4, 99, `${prefix} Rate 4`),
                level1: byte(fields.level1, 99, `${prefix} Level 1`),
                level2: byte(fields.level2, 99, `${prefix} Level 2`),
                level3: byte(fields.level3, 99, `${prefix} Level 3`),
                level4: byte(fields.level4, 99, `${prefix} Level 4`),
                breakPoint: byte(fields.breakPoint, 99, `${prefix} Break Point`),
                leftDepth: byte(fields.leftDepth, 99, `${prefix} Left Depth`),
                rightDepth: byte(fields.rightDepth, 99, `${prefix} Right Depth`),
                leftCurve: choice(fields.leftCurve, Tubular.Curves, `${prefix} Left Curve`),
                rightCurve: choice(fields.rightCurve, Tubular.Curves, `${prefix} Right Curve`),
                rateScaling: byte(fields.rateScaling, 7, `${prefix} Rate Scaling`),
                ampModSens: byte(fields.ampModSens, 3, `${prefix} Amp Mod Sens`),
                velocitySens: byte(fields.velocitySens, 7, `${prefix} Velocity Sens`),
                outputLevel: byte(fields.outputLevel, 99, `${prefix} Level`),
                mode: choice(fields.mode, Tubular.Modes, `${prefix} Mode`),
                coarse: byte(fields.coarse, 31, `${prefix} Coarse`),
                fine: byte(fields.fine, 99, `${prefix} Fine`),
                detune: choice(fields.detune, Tubular.Detunes, `${prefix} Detune`),
                enabled: choice(fields.enabled, Tubular.Switch, `${prefix} Switch`)
            }
        }
        return {
            cutoff: this.#parametric.createParameter(
                box.cutoff, ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Cutoff", 1.0),
            resonance: this.#parametric.createParameter(
                box.resonance, ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Resonance"),
            output: this.#parametric.createParameter(
                box.output, ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Output", 1.0),
            voicingMode: this.#parametric.createParameter(
                box.voicingMode, ValueMapping.values(VoiceModes),
                StringMapping.values("", VoiceModes, ["mono", "poly"]), "Play Mode", 0.5),
            tune: this.#parametric.createParameter(
                box.tune, ValueMapping.linear(-100, 100),
                StringMapping.numeric({unit: "ct", fractionDigits: 0}), "Tune", 0.5),
            algorithm: choice(box.algorithm, Tubular.Algorithms, "Algorithm"),
            feedback: byte(box.feedback, 7, "Feedback"),
            oscKeySync: choice(box.oscKeySync, Tubular.Switch, "Osc Key Sync"),
            lfo: {
                speed: byte(box.lfo.speed, 99, "LFO Speed"),
                delay: byte(box.lfo.delay, 99, "LFO Delay"),
                pmDepth: byte(box.lfo.pmDepth, 99, "LFO PM Depth"),
                amDepth: byte(box.lfo.amDepth, 99, "LFO AM Depth"),
                sync: choice(box.lfo.sync, Tubular.Switch, "LFO Key Sync"),
                wave: choice(box.lfo.wave, Tubular.LfoWaves, "LFO Wave")
            },
            pitchModSens: byte(box.pitchModSens, 7, "Pitch Mod Sens"),
            transpose: choice(box.transpose, Tubular.Transposes, "Transpose"),
            pitchEnvelope: {
                rate1: byte(box.pitchEnvelope.rate1, 99, "Pitch EG Rate 1"),
                rate2: byte(box.pitchEnvelope.rate2, 99, "Pitch EG Rate 2"),
                rate3: byte(box.pitchEnvelope.rate3, 99, "Pitch EG Rate 3"),
                rate4: byte(box.pitchEnvelope.rate4, 99, "Pitch EG Rate 4"),
                level1: byte(box.pitchEnvelope.level1, 99, "Pitch EG Level 1"),
                level2: byte(box.pitchEnvelope.level2, 99, "Pitch EG Level 2"),
                level3: byte(box.pitchEnvelope.level3, 99, "Pitch EG Level 3"),
                level4: byte(box.pitchEnvelope.level4, 99, "Pitch EG Level 4")
            },
            operators: box.operators.fields().map(operator)
        } as const
    }
}
