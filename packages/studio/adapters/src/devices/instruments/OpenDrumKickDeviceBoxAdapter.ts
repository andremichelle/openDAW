import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumKickDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {OpenDrum} from "./OpenDrum"
import {OpenDrumDeviceBoxAdapter} from "./OpenDrumDeviceBoxAdapter"

const wrap = (parameter: ParameterAdapterSet, box: OpenDrumKickDeviceBox) => {
    const {hertz, semitones, seconds, percent, decibel} = OpenDrum.Strings
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

export class OpenDrumKickDeviceBoxAdapter
    extends OpenDrumDeviceBoxAdapter<OpenDrumKickDeviceBox, ReturnType<typeof wrap>> {
    constructor(context: BoxAdaptersContext, box: OpenDrumKickDeviceBox) {
        super(context, box, DeviceManualUrls.OpenDrumKick, wrap)
    }
}
