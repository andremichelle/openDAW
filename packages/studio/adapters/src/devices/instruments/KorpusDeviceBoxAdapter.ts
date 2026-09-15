import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {KorpusDeviceBox} from "@opendaw/studio-boxes"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class KorpusDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = "manuals/devices/instruments/korpus"

    readonly #context: BoxAdaptersContext
    readonly #box: KorpusDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: KorpusDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): KorpusDeviceBox {return this.#box}
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

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: KorpusDeviceBox) {
        const unipolar = (field: Parameters<ParameterAdapterSet["createParameter"]>[0], name: string) =>
            this.#parametric.createParameter(field, ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), name)
        const semitones = (field: Parameters<ParameterAdapterSet["createParameter"]>[0], name: string) =>
            this.#parametric.createParameter(field, ValueMapping.linearInteger(-24, 24),
                StringMapping.numeric({unit: "st", fractionDigits: 0}), name, 0.5)
        const objectLabels = ["Marimba", "Vibraphone", "Bell", "Membrane", "Plate", "Piano Wire"]
        return {
            exciter: this.#parametric.createParameter(
                box.exciter, ValueMapping.linearInteger(0, 4),
                StringMapping.indices("", ["Strike", "Breath", "Bow", "Pick", "Wind"]), "Exciter"),
            intensity: unipolar(box.intensity, "Intensity"),
            position: unipolar(box.position, "Position"),
            vibrato: unipolar(box.vibrato, "Vibrato"),
            objectA: this.#parametric.createParameter(
                box.objectA, ValueMapping.linearInteger(0, 5),
                StringMapping.indices("", objectLabels), "Object A"),
            dampingA: unipolar(box.dampingA, "Damping A"),
            tuneA: semitones(box.tuneA, "Tune A"),
            widthA: unipolar(box.widthA, "Width A"),
            objectB: this.#parametric.createParameter(
                box.objectB, ValueMapping.linearInteger(0, 6),
                StringMapping.indices("", [...objectLabels, "Off"]), "Object B"),
            dampingB: unipolar(box.dampingB, "Damping B"),
            tuneB: semitones(box.tuneB, "Tune B"),
            detuneB: this.#parametric.createParameter(
                box.detuneB, ValueMapping.linear(-25.0, 25.0),
                StringMapping.numeric({unit: "ct", fractionDigits: 0}), "Detune B", 0.5),
            widthB: unipolar(box.widthB, "Width B"),
            levelB: unipolar(box.levelB, "Level B"),
            routing: this.#parametric.createParameter(
                box.routing, ValueMapping.linearInteger(0, 1),
                StringMapping.indices("", ["Parallel", "Serial"]), "Routing"),
            couple: unipolar(box.couple, "Couple"),
            volume: this.#parametric.createParameter(
                box.volume, ValueMapping.DefaultDecibel, StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Volume")
        } as const
    }
}
