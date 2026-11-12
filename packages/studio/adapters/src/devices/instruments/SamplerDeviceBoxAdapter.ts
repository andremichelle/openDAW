import {SamplerAmpEnvelope, SamplerDeviceBox, SamplerLfoA, SamplerLfoB, SamplerModEnvelope} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {IndexedBoxAdapterCollection} from "../../IndexedBoxAdapterCollection"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {SamplerZoneBoxAdapter} from "./Sampler/SamplerZoneBoxAdapter"
import {SamplerGroupBoxAdapter} from "./Sampler/SamplerGroupBoxAdapter"
import {SamplerModulationBoxAdapter} from "./Sampler/SamplerModulationBoxAdapter"

export class SamplerDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    static readonly FilterTypeNames: ReadonlyArray<string> = ["Off", "LP 12", "LP 24", "HP 12"]
    static readonly LfoShapeNames: ReadonlyArray<string> = ["Sine", "Tri", "Saw", "Square"]

    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Sampler

    readonly #context: BoxAdaptersContext
    readonly #box: SamplerDeviceBox

    readonly #zones: IndexedBoxAdapterCollection<SamplerZoneBoxAdapter, Pointers.SamplerZone>
    readonly #groups: IndexedBoxAdapterCollection<SamplerGroupBoxAdapter, Pointers.SamplerGroup>
    readonly #modulations: IndexedBoxAdapterCollection<SamplerModulationBoxAdapter, Pointers.SamplerModulation>
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: SamplerDeviceBox) {
        this.#context = context
        this.#box = box
        this.#zones = IndexedBoxAdapterCollection.create(box.zones,
            box => context.boxAdapters.adapterFor(box, SamplerZoneBoxAdapter), Pointers.SamplerZone)
        this.#groups = IndexedBoxAdapterCollection.create(box.groups,
            box => context.boxAdapters.adapterFor(box, SamplerGroupBoxAdapter), Pointers.SamplerGroup)
        this.#modulations = IndexedBoxAdapterCollection.create(box.modulations,
            box => context.boxAdapters.adapterFor(box, SamplerModulationBoxAdapter), Pointers.SamplerModulation)
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): SamplerDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}
    get zones(): IndexedBoxAdapterCollection<SamplerZoneBoxAdapter, Pointers.SamplerZone> {return this.#zones}
    get groups(): IndexedBoxAdapterCollection<SamplerGroupBoxAdapter, Pointers.SamplerGroup> {return this.#groups}
    get modulations(): IndexedBoxAdapterCollection<SamplerModulationBoxAdapter, Pointers.SamplerModulation> {
        return this.#modulations
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
        this.#zones.terminate()
        this.#groups.terminate()
        this.#modulations.terminate()
        this.#parametric.terminate()
    }

    #wrapEnvelope(envelope: SamplerAmpEnvelope | SamplerModEnvelope) {
        const seconds = StringMapping.numeric({unit: "s", fractionDigits: 3})
        return {
            delay: this.#parametric.createParameter(envelope.delay, ValueMapping.linear(0.0, 5.0), seconds, "Delay"),
            attack: this.#parametric.createParameter(envelope.attack, ValueMapping.exponential(0.001, 8.0), seconds, "Attack"),
            hold: this.#parametric.createParameter(envelope.hold, ValueMapping.linear(0.0, 5.0), seconds, "Hold"),
            decay: this.#parametric.createParameter(envelope.decay, ValueMapping.exponential(0.001, 8.0), seconds, "Decay"),
            sustain: this.#parametric.createParameter(envelope.sustain, ValueMapping.unipolar(), StringMapping.percent(), "Sustain"),
            release: this.#parametric.createParameter(envelope.release, ValueMapping.exponential(0.001, 8.0), seconds, "Release")
        } as const
    }

    #wrapLfo(lfo: SamplerLfoA | SamplerLfoB) {
        const seconds = StringMapping.numeric({unit: "s", fractionDigits: 3})
        return {
            shape: this.#parametric.createParameter(lfo.shape, ValueMapping.linearInteger(0, 3),
                StringMapping.indices("", SamplerDeviceBoxAdapter.LfoShapeNames), "Shape"),
            rate: this.#parametric.createParameter(lfo.rate, ValueMapping.exponential(0.01, 30.0),
                StringMapping.numeric({unit: "Hz", fractionDigits: 2}), "Rate"),
            delay: this.#parametric.createParameter(lfo.delay, ValueMapping.linear(0.0, 5.0), seconds, "Delay"),
            fade: this.#parametric.createParameter(lfo.fade, ValueMapping.linear(0.0, 5.0), seconds, "Fade"),
            sync: this.#parametric.createParameter(lfo.sync, ValueMapping.bool, StringMapping.bool, "Sync"),
            restart: this.#parametric.createParameter(lfo.restart, ValueMapping.bool, StringMapping.bool, "Restart")
        } as const
    }

    #wrapParameters(box: SamplerDeviceBox) {
        return {
            voices: this.#parametric.createParameter(box.voices, ValueMapping.linearInteger(1, 64),
                StringMapping.numeric({}), "Voices"),
            glide: this.#parametric.createParameter(box.glide, ValueMapping.linear(0.0, 5.0),
                StringMapping.numeric({unit: "s", fractionDigits: 3}), "Glide"),
            legato: this.#parametric.createParameter(box.legato, ValueMapping.bool, StringMapping.bool, "Legato"),
            octave: this.#parametric.createParameter(box.octave, ValueMapping.linearInteger(-3, 3),
                StringMapping.numeric({unit: "oct"}), "Octave", 0.5),
            transpose: this.#parametric.createParameter(box.transpose, ValueMapping.linearInteger(-12, 12),
                StringMapping.numeric({unit: "st"}), "Transp", 0.5),
            tune: this.#parametric.createParameter(box.tune, ValueMapping.linear(-100.0, 100.0),
                StringMapping.numeric({unit: "ct", fractionDigits: 0}), "Tune", 0.5),
            filterType: this.#parametric.createParameter(box.filterType, ValueMapping.linearInteger(0, 3),
                StringMapping.indices("", SamplerDeviceBoxAdapter.FilterTypeNames), "Type"),
            cutoff: this.#parametric.createParameter(box.cutoff, ValueMapping.exponential(20.0, 20_000.0),
                StringMapping.numeric({unit: "Hz"}), "Cutoff"),
            resonance: this.#parametric.createParameter(box.resonance, ValueMapping.unipolar(),
                StringMapping.percent(), "Reso"),
            volume: this.#parametric.createParameter(box.volume, ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "db", fractionDigits: 1}), "Volume"),
            panning: this.#parametric.createParameter(box.panning, ValueMapping.bipolar(),
                StringMapping.panning, "Pan", 0.5),
            mono: this.#parametric.createParameter(box.mono, ValueMapping.unipolar(), StringMapping.percent(), "Mono"),
            ampEnvelope: this.#wrapEnvelope(box.ampEnvelope),
            modEnvelope: this.#wrapEnvelope(box.modEnvelope),
            lfoA: this.#wrapLfo(box.lfoA),
            lfoB: this.#wrapLfo(box.lfoB)
        } as const
    }
}
