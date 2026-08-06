import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {CubedDeviceBox} from "@opendaw/studio-boxes"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {IndexedBoxAdapterCollection} from "../../IndexedBoxAdapterCollection"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {CubedPatternBoxAdapter} from "./Cubed/CubedPatternBoxAdapter"

export class CubedDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = "manuals/devices/instruments/cubed"

    readonly #context: BoxAdaptersContext
    readonly #box: CubedDeviceBox

    readonly #patterns: IndexedBoxAdapterCollection<CubedPatternBoxAdapter, Pointers.Pattern>
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: CubedDeviceBox) {
        this.#context = context
        this.#box = box
        this.#patterns = IndexedBoxAdapterCollection.create(
            box.patterns, box => context.boxAdapters.adapterFor(box, CubedPatternBoxAdapter), Pointers.Pattern)
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
    get patterns(): IndexedBoxAdapterCollection<CubedPatternBoxAdapter, Pointers.Pattern> {return this.#patterns}

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
        this.#patterns.terminate()
    }

    #wrapParameters(box: CubedDeviceBox) {
        const unipolar = (field: Parameters<ParameterAdapterSet["createParameter"]>[0], name: string, anchor?: number) =>
            this.#parametric.createParameter(field, ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), name, anchor)
        return {
            tuning: unipolar(box.tuning, "Tuning", 0.5),
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
