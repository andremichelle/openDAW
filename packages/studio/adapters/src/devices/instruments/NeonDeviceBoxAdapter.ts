import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {NeonDeviceBox, NeonEnvelope} from "@opendaw/studio-boxes"
import {Address, BooleanField, Int32Field, StringField} from "@opendaw/lib-box"
import {Pointers, VoicingMode} from "@opendaw/studio-enums"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export namespace Neon {
    export const Waves = ["Saw", "Square", "Pulse", "Double Sine", "Saw-Pulse", "Res. Saw", "Res. Triangle", "Res. Trapezoid"]
    export const LineSelect = ["1", "2", "1+1'", "1+2'"]
    export const Modulation = ["Off", "Ring", "Noise"]
    export const VibratoWaves = ["Triangle", "Saw Up", "Saw Down", "Square"]
    // The `envelopes` array order: line1 pitch, line1 DCW, line1 DCA, line2 pitch, line2 DCW, line2 DCA.
    export const envelopeIndex = (line: 0 | 1, kind: "pitch" | "dcw" | "dca"): number =>
        line * 3 + (kind === "pitch" ? 0 : kind === "dcw" ? 1 : 2)
}

export class NeonDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Neon

    readonly #context: BoxAdaptersContext
    readonly #box: NeonDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: NeonDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): NeonDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}

    envelope(line: 0 | 1, kind: "pitch" | "dcw" | "dca"): NeonEnvelope {
        return this.#box.envelopes.fields()[Neon.envelopeIndex(line, kind)]
    }

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

    #wrapParameters(box: NeonDeviceBox) {
        const VoiceModes = [VoicingMode.Monophonic, VoicingMode.Polyphonic]
        const czValue = (field: Int32Field<Pointers.Automation | Pointers.MIDIControl | Pointers.Modulation>, name: string) =>
            this.#parametric.createParameter(field, ValueMapping.linearInteger(0, 99),
                StringMapping.numeric({unit: "", fractionDigits: 0}), name)
        return {
            lineSelect: this.#parametric.createParameter(
                box.lineSelect,
                ValueMapping.linearInteger(0, 3),
                StringMapping.indices("", Neon.LineSelect), "Line"),
            modulation: this.#parametric.createParameter(
                box.modulation,
                ValueMapping.linearInteger(0, 2),
                StringMapping.indices("", Neon.Modulation), "Mod"),
            octave: this.#parametric.createParameter(
                box.octave,
                ValueMapping.linearInteger(-1, 1),
                StringMapping.numeric({unit: "oct"}), "Octave", 0.5),
            detuneNote: this.#parametric.createParameter(
                box.detuneNote,
                ValueMapping.linearInteger(-48, 48),
                StringMapping.numeric({unit: "st"}), "Detune Note", 0.5),
            detuneFine: this.#parametric.createParameter(
                box.detuneFine,
                ValueMapping.linearInteger(-60, 60),
                StringMapping.numeric({unit: ""}), "Detune Fine", 0.5),
            glideTime: this.#parametric.createParameter(
                box.glideTime,
                ValueMapping.unipolar(),
                StringMapping.percent({fractionDigits: 1}), "Glide time", 0.0),
            bendRange: this.#parametric.createParameter(
                box.bendRange,
                ValueMapping.linearInteger(0, 12),
                StringMapping.numeric({unit: "st"}), "Bend Range"),
            voicingMode: this.#parametric.createParameter(
                box.voicingMode,
                ValueMapping.values(VoiceModes),
                StringMapping.values("", VoiceModes, ["mono", "poly"]), "Play Mode", 0.5),
            vibrato: {
                wave: this.#parametric.createParameter(
                    box.vibrato.wave,
                    ValueMapping.linearInteger(0, 3),
                    StringMapping.indices("", Neon.VibratoWaves), "Vib. Wave"),
                delay: czValue(box.vibrato.delay, "Vib. Delay"),
                rate: czValue(box.vibrato.rate, "Vib. Rate"),
                depth: czValue(box.vibrato.depth, "Vib. Depth")
            },
            lines: box.lines.fields().map(line => ({
                wave1: this.#parametric.createParameter(
                    line.wave1,
                    ValueMapping.linearInteger(0, 7),
                    StringMapping.indices("", Neon.Waves), "Wave 1"),
                wave2: this.#parametric.createParameter(
                    line.wave2,
                    ValueMapping.linearInteger(0, 8),
                    StringMapping.indices("", ["Off", ...Neon.Waves]), "Wave 2"),
                dcwKeyFollow: this.#parametric.createParameter(
                    line.dcwKeyFollow,
                    ValueMapping.linearInteger(0, 9),
                    StringMapping.numeric({unit: ""}), "DCW Key Follow"),
                dcaKeyFollow: this.#parametric.createParameter(
                    line.dcaKeyFollow,
                    ValueMapping.linearInteger(0, 9),
                    StringMapping.numeric({unit: ""}), "DCA Key Follow")
            }))
        } as const
    }
}
