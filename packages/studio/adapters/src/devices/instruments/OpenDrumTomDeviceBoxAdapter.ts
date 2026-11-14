import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumTomDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {OpenDrum} from "./OpenDrum"
import {OpenDrumDeviceBoxAdapter} from "./OpenDrumDeviceBoxAdapter"

const wrap = (parameter: ParameterAdapterSet, box: OpenDrumTomDeviceBox) => {
    const {decibel, hertz, percent, seconds, semitones} = OpenDrum.Strings
    return {
        tune: parameter.createParameter(box.tune, ValueMapping.exponential(40, 800), hertz, "Tune"),
        pitch: parameter.createParameter(box.pitch, ValueMapping.linear(0, 24), semitones, "Pitch"),
        sweep: parameter.createParameter(box.sweep, ValueMapping.exponential(0.001, 0.2), seconds, "Sweep"),
        drift: parameter.createParameter(box.drift, ValueMapping.linear(0, 12), semitones, "Drift"),
        decay: parameter.createParameter(box.decay, ValueMapping.exponential(0.02, 3), seconds, "Decay"),
        punch: parameter.createParameter(box.punch, ValueMapping.bipolar(), percent, "Punch", 0.5),
        shape: parameter.createParameter(box.shape, ValueMapping.unipolar(), percent, "Shape"),
        sub: parameter.createParameter(box.sub, ValueMapping.unipolar(), percent, "Sub"),
        ratio: parameter.createParameter(box.ratio, ValueMapping.linear(0.5, 1),
            StringMapping.numeric({fractionDigits: 2}), "Ratio"),
        top: parameter.createParameter(box.top, ValueMapping.unipolar(), percent, "Top"),
        length: parameter.createParameter(box.length, ValueMapping.exponential(0.02, 1), seconds, "Length"),
        drive: parameter.createParameter(box.drive, ValueMapping.linear(0, 36), decibel, "Drive"),
        noise: parameter.createParameter(box.noise, ValueMapping.linear(-48, 0), decibel, "Noise Level"),
        noiseDecay: parameter.createParameter(box.noiseDecay, ValueMapping.exponential(0.02, 3),
            seconds, "Noise Decay"),
        color: parameter.createParameter(box.color, ValueMapping.unipolar(), percent, "Color"),
        air: parameter.createParameter(box.air, ValueMapping.unipolar(), percent, "Air"),
        volume: parameter.createParameter(box.volume, ValueMapping.linear(-36, 6), decibel, "Volume"),
        velocity: parameter.createParameter(box.velocity, ValueMapping.unipolar(), percent, "Velocity"),
        play: parameter.createParameter(box.play, OpenDrum.choice(OpenDrum.PlayModes),
            StringMapping.indices("", OpenDrum.PlayModes), "Mode"),
        glide: parameter.createParameter(box.glide, ValueMapping.linear(0, 1), seconds, "Glide")
    } as const
}

export class OpenDrumTomDeviceBoxAdapter
    extends OpenDrumDeviceBoxAdapter<OpenDrumTomDeviceBox, ReturnType<typeof wrap>> {
    constructor(context: BoxAdaptersContext, box: OpenDrumTomDeviceBox) {
        super(context, box, DeviceManualUrls.OpenDrumTom, wrap)
    }
}
