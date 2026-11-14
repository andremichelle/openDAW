import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumKickDeviceBox} from "@opendaw/studio-boxes"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {OpenDrum} from "./OpenDrum"

export class OpenDrumKickDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.OpenDrumKick

    readonly #context: BoxAdaptersContext
    readonly #box: OpenDrumKickDeviceBox

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: OpenDrumKickDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): OpenDrumKickDeviceBox {return this.#box}
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

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: OpenDrumKickDeviceBox) {
        const {hertz, semitones, seconds, percent, decibel} = OpenDrum.Strings
        const parameter = this.#parametric
        return {
            tune: parameter.createParameter(box.tune, ValueMapping.exponential(30.0, 120.0), hertz, "Tune"),
            pitch: parameter.createParameter(box.pitch, ValueMapping.linear(0.0, 48.0), semitones, "Pitch"),
            sweep: parameter.createParameter(box.sweep, ValueMapping.exponential(0.001, 0.2), seconds, "Sweep"),
            drift: parameter.createParameter(box.drift, ValueMapping.linear(0.0, 12.0), semitones, "Drift"),
            decay: parameter.createParameter(box.decay, ValueMapping.exponential(0.02, 6.0), seconds, "Decay"),
            punch: parameter.createParameter(box.punch, ValueMapping.bipolar(), percent, "Punch", 0.5),
            shape: parameter.createParameter(box.shape, ValueMapping.unipolar(), percent, "Shape"),
            skin: parameter.createParameter(box.skin, ValueMapping.unipolar(), percent, "Skin"),
            click: parameter.createParameter(box.click, ValueMapping.unipolar(), percent, "Click"),
            tone: parameter.createParameter(box.tone, ValueMapping.exponential(200.0, 16000.0), hertz, "Tone"),
            noise: parameter.createParameter(box.noise, ValueMapping.unipolar(), percent, "Noise"),
            drive: parameter.createParameter(box.drive, ValueMapping.linear(0.0, 36.0), decibel, "Drive"),
            rumble: parameter.createParameter(box.rumble, ValueMapping.unipolar(), percent, "Rumble"),
            length: parameter.createParameter(box.length, OpenDrum.choice(OpenDrum.RumbleLengths),
                StringMapping.indices("", OpenDrum.RumbleLengths), "Length"),
            duck: parameter.createParameter(box.duck, ValueMapping.unipolar(), percent, "Duck"),
            bright: parameter.createParameter(box.bright, ValueMapping.unipolar(), percent, "Bright"),
            volume: parameter.createParameter(box.volume, ValueMapping.linear(-36.0, 6.0), decibel, "Volume"),
            velocity: parameter.createParameter(box.velocity, ValueMapping.unipolar(), percent, "Velocity"),
            play: parameter.createParameter(box.play, OpenDrum.choice(OpenDrum.PlayModes),
                StringMapping.indices("", OpenDrum.PlayModes), "Mode"),
            glide: parameter.createParameter(box.glide, ValueMapping.linear(0.0, 1.0), seconds, "Glide")
        } as const
    }
}
