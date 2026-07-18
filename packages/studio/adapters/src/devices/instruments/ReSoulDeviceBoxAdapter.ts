import {ReSoulDeviceBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {MidiKeys} from "@opendaw/lib-dsp"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {AudioFileBoxAdapter} from "../../audio/AudioFileBoxAdapter"

const RootKeyLabels: ReadonlyArray<string> = Array.from({length: 128}, (_, note) => MidiKeys.toFullString(note))

export class ReSoulDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.ReSoul

    readonly #context: BoxAdaptersContext
    readonly #box: ReSoulDeviceBox
    readonly #terminator: Terminator

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    #file: Option<AudioFileBoxAdapter> = Option.None

    constructor(context: BoxAdaptersContext, box: ReSoulDeviceBox) {
        this.#context = context
        this.#box = box
        this.#terminator = new Terminator()
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
        this.#terminator.own(this.#box.file.catchupAndSubscribe(pointer => {
            this.#file = pointer.targetVertex.map(({box}) => this.#context.boxAdapters.adapterFor(box, AudioFileBoxAdapter))
            this.#file.unwrapOrNull()?.getOrCreateLoader()
        }))
    }

    get box(): ReSoulDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}
    get positionsAddress(): Address {return this.#box.address.append(1001)}

    file(): Option<AudioFileBoxAdapter> {return this.#file}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#terminator.terminate()
        this.#parametric.terminate()
    }

    #wrapParameters(box: ReSoulDeviceBox) {
        return {
            volume: this.#parametric.createParameter(
                box.volume,
                ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "db", fractionDigits: 1}), "volume"),
            octave: this.#parametric.createParameter(
                box.octave,
                ValueMapping.linearInteger(-3, 3),
                StringMapping.numeric({unit: "oct"}), "octave", 0.5),
            reverse: this.#parametric.createParameter(
                box.reverse,
                ValueMapping.bool,
                StringMapping.bool, "reverse"),
            rootKey: this.#parametric.createParameter(
                box.rootKey,
                ValueMapping.linearInteger(0, 127),
                StringMapping.indices("", RootKeyLabels), "root", 60 / 127),
            attack: this.#parametric.createParameter(
                box.attack,
                ValueMapping.exponential(0.001, 5.0),
                StringMapping.numeric({unit: "s", fractionDigits: 3}), "attack"),
            release: this.#parametric.createParameter(
                box.release,
                ValueMapping.exponential(0.001, 8.0),
                StringMapping.numeric({unit: "s", fractionDigits: 3}), "release"),
            sampleStart: this.#parametric.createParameter(
                box.sampleStart,
                ValueMapping.unipolar(),
                StringMapping.percent(), "start", 0.0),
            sampleEnd: this.#parametric.createParameter(
                box.sampleEnd,
                ValueMapping.unipolar(),
                StringMapping.percent(), "end", 1.0)
        } as const
    }
}
