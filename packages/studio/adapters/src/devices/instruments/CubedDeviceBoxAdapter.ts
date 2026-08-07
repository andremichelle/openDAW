import {int, Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {CubedDeviceBox, CubedPattern} from "@opendaw/studio-boxes"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {CubedStep} from "./Cubed/CubedStep"

const DefaultStep = CubedStep.pack({note: CubedStep.DefaultNote, active: false, slide: false, accent: false})
const CMinor = [0, 2, 3, 5, 7, 8, 10]
const randomStep = (): int => CubedStep.pack({
    note: 36 + Math.floor(Math.random() * 3) * 12 + CMinor[Math.floor(Math.random() * CMinor.length)],
    active: Math.random() < 0.6,
    slide: Math.random() < 0.2,
    accent: Math.random() < 0.3
})

export class CubedDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = "manuals/devices/instruments/cubed"

    readonly #context: BoxAdaptersContext
    readonly #box: CubedDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: CubedDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): CubedDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}

    currentPattern(): CubedPattern {return this.#box.patterns.getField(this.#box.patternIndex.getValue())}

    clearCurrentPattern(): void {
        this.currentPattern().steps.fields().forEach(field => field.setValue(DefaultStep))
    }

    randomizeCurrentPattern(): void {
        const pattern = this.currentPattern()
        const length = pattern.length.getValue()
        pattern.steps.fields().forEach((field, index) => field.setValue(index < length ? randomStep() : DefaultStep))
    }

    rotateCurrentPattern(offset: int): void {
        const pattern = this.currentPattern()
        const length = pattern.length.getValue()
        const fields = pattern.steps.fields().slice(0, length)
        const values = fields.map(field => field.getValue())
        fields.forEach((field, index) => field.setValue(values[(index + offset + length) % length]))
    }

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: CubedDeviceBox) {
        const unipolar = (field: Parameters<ParameterAdapterSet["createParameter"]>[0], name: string, anchor?: number) =>
            this.#parametric.createParameter(field, ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), name, anchor)
        return {
            tuning: this.#parametric.createParameter(
                box.tuning, ValueMapping.linear(-1200, 1200), StringMapping.numeric({unit: "ct", fractionDigits: 0}), "Tuning", 0.5),
            cutoff: unipolar(box.cutoff, "Cutoff"),
            resonance: unipolar(box.resonance, "Resonance"),
            envMod: unipolar(box.envMod, "Env Mod"),
            decay: unipolar(box.decay, "Decay"),
            accent: unipolar(box.accent, "Accent"),
            volume: this.#parametric.createParameter(
                box.volume, ValueMapping.DefaultDecibel, StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Volume"),
            waveform: this.#parametric.createParameter(
                box.waveform, ValueMapping.linearInteger(0, 1), StringMapping.indices("", ["Sawtooth", "Square"]), "Waveform", 0.5),
            patternIndex: this.#parametric.createParameter(
                box.patternIndex, ValueMapping.linearInteger(0, 127), StringMapping.numeric({unit: ""}), "Pattern")
        } as const
    }
}
