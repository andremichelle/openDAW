import {Option, StringMapping, Terminable, UUID, ValueMapping} from "@opendaw/lib-std"
import {VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {VoicingMode} from "@opendaw/studio-enums"
import {VaporisateurSettings} from "./VaporisateurSettings"

export class VaporisateurDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"

    readonly #context: BoxAdaptersContext
    readonly #box: VaporisateurDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly #outputRegistration: Terminable
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: VaporisateurDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
        this.#outputRegistration = context.isMainThread
            ? context.audioOutputInfoRegistry.register({address: box.address, owner: Option.None, label: () => box.label.getValue()})
            : Terminable.Empty
    }

    get box(): VaporisateurDeviceBox {return this.#box}
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

    terminate(): void {
        this.#parametric.terminate()
        this.#outputRegistration.terminate()
    }

    #wrapParameters(box: VaporisateurDeviceBox) {
        const VoiceModes = [VoicingMode.Monophonic, VoicingMode.Polyphonic]
        return {
            oscillators: box.oscillators.fields().map(osc => ({
                waveform: this.#parametric.createParameter(
                    osc.waveform,
                    ValueMapping.linearInteger(0, 3),
                    StringMapping.indices("", ["Sine", "Triangle", "Sawtooth", "Square"]), "Waveform"),
                volume: this.#parametric.createParameter(
                    osc.volume,
                    ValueMapping.DefaultDecibel,
                    StringMapping.numeric({unit: "db", fractionDigits: 1}), "Volume"),
                octave: this.#parametric.createParameter(
                    osc.octave,
                    ValueMapping.linearInteger(-3, 3),
                    StringMapping.numeric({unit: "oct"}), "Octave", 0.5),
                tune: this.#parametric.createParameter(
                    osc.tune,
                    ValueMapping.linear(-1200.0, +1200.0),
                    StringMapping.numeric({unit: "ct", fractionDigits: 0}), "Tune", 0.5)
            })),
            noise: {
                volume: this.#parametric.createParameter(
                    box.noise.volume,
                    ValueMapping.DefaultDecibel,
                    StringMapping.numeric({unit: "db", fractionDigits: 1}), "Volume"),
                attack: this.#parametric.createParameter(
                    box.noise.attack,
                    ValueMapping.exponential(0.001, 5.0),
                    StringMapping.numeric({unit: "s", fractionDigits: 3}), "Attack"),
                hold: this.#parametric.createParameter(
                    box.noise.hold,
                    ValueMapping.exponential(0.001, 5.0),
                    StringMapping.numeric({unit: "s", fractionDigits: 3}), "Hold"),
                release: this.#parametric.createParameter(
                    box.noise.release,
                    ValueMapping.exponential(0.001, 5.0),
                    StringMapping.numeric({unit: "s", fractionDigits: 3}), "Release")
            },
            filterOrder: this.#parametric.createParameter(
                box.filterOrder,
                VaporisateurSettings.FILTER_ORDER_VALUE_MAPPING,
                VaporisateurSettings.FILTER_ORDER_STRING_MAPPING, "Flt. Order"),
            cutoff: this.#parametric.createParameter(
                box.cutoff,
                VaporisateurSettings.CUTOFF_VALUE_MAPPING,
                VaporisateurSettings.CUTOFF_STRING_MAPPING, "Flt. Cutoff"),
            resonance: this.#parametric.createParameter(
                box.resonance,
                ValueMapping.exponential(0.01, 10.0),
                StringMapping.numeric({unit: "q", fractionDigits: 3}), "Flt. Q"),
            attack: this.#parametric.createParameter(
                box.attack,
                ValueMapping.exponential(0.001, 5.0),
                StringMapping.numeric({unit: "s", fractionDigits: 3}), "Attack"),
            decay: this.#parametric.createParameter(
                box.decay,
                ValueMapping.exponential(0.001, 5.0),
                StringMapping.numeric({unit: "s", fractionDigits: 3}), "Decay"),
            sustain: this.#parametric.createParameter(
                box.sustain,
                ValueMapping.unipolar(),
                StringMapping.percent({fractionDigits: 1}), "Sustain"),
            release: this.#parametric.createParameter(
                box.release,
                ValueMapping.exponential(0.001, 5.0),
                StringMapping.numeric({unit: "s", fractionDigits: 3}), "Release"),
            filterEnvelope: this.#parametric.createParameter(
                box.filterEnvelope,
                ValueMapping.bipolar(),
                StringMapping.percent({fractionDigits: 1}), "Flt. Env.", 0.5),
            filterKeyboard: this.#parametric.createParameter(
                box.filterKeyboard,
                ValueMapping.bipolar(),
                StringMapping.percent({fractionDigits: 1}), "Flt. Kbd.", 0.5),
            voicingMode: this.#parametric.createParameter(
                box.voicingMode,
                ValueMapping.values(VoiceModes),
                StringMapping.values("", VoiceModes, ["mono", "poly"]), "Play Mode", 0.5),
            glideTime: this.#parametric.createParameter(
                box.glideTime,
                ValueMapping.unipolar(),
                StringMapping.percent({fractionDigits: 1}), "Glide time", 0.0),
            unisonCount: this.#parametric.createParameter(
                box.unisonCount,
                ValueMapping.values([1, 3, 5]),
                StringMapping.values("#", [1, 3, 5], [1, 3, 5].map(x => String(x))), "Unisono", 0.0),
            unisonDetune: this.#parametric.createParameter(
                box.unisonDetune,
                ValueMapping.exponential(1.0, 1200.0),
                StringMapping.numeric({unit: "ct", fractionDigits: 0}), "Detune", 0.0),
            unisonStereo: this.#parametric.createParameter(
                box.unisonStereo,
                ValueMapping.unipolar(),
                StringMapping.percent({fractionDigits: 0}), "Stereo", 0.0),
            lfoWaveform: this.#parametric.createParameter(
                box.lfo.waveform,
                VaporisateurSettings.LFO_WAVEFORM_VALUE_MAPPING,
                VaporisateurSettings.LFO_WAVEFORM_STRING_MAPPING, "LFO Shape", 0.0),
            lfoRate: this.#parametric.createParameter(
                box.lfo.rate,
                ValueMapping.exponential(0.0001, 30.0),
                StringMapping.numeric({unit: "Hz", fractionDigits: 1, unitPrefix: true}), "Rate", 0.0),
            lfoTargetTune: this.#parametric.createParameter(
                box.lfo.targetTune,
                ValueMapping.bipolar(),
                StringMapping.percent({fractionDigits: 1}), "Vibrato ⦿", 0.5),
            lfoTargetVolume: this.#parametric.createParameter(
                box.lfo.targetVolume,
                ValueMapping.bipolar(),
                StringMapping.percent({fractionDigits: 1}), "Tremolo ⦿", 0.5),
            lfoTargetCutoff: this.#parametric.createParameter(
                box.lfo.targetCutoff,
                ValueMapping.bipolar(),
                StringMapping.percent({fractionDigits: 1}), "Cutoff ⦿", 0.5)
        } as const
    }
}