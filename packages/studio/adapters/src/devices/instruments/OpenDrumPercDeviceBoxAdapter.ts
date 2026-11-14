import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumPercDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {OpenDrum} from "./OpenDrum"
import {OpenDrumDeviceBoxAdapter} from "./OpenDrumDeviceBoxAdapter"

const wrap = (parameter: ParameterAdapterSet, box: OpenDrumPercDeviceBox) => {
    const {decibel, hertz, percent, seconds, semitones} = OpenDrum.Strings
    return {
        tune: parameter.createParameter(box.tune, ValueMapping.exponential(20, 8000), hertz, "Tune"),
        ratio: parameter.createParameter(box.ratio, ValueMapping.exponential(0.25, 16),
            StringMapping.numeric({fractionDigits: 2}), "Ratio"),
        index: parameter.createParameter(box.index, ValueMapping.unipolar(), percent, "Index"),
        bite: parameter.createParameter(box.bite, ValueMapping.exponential(0.001, 2), seconds, "Bite"),
        pitch: parameter.createParameter(box.pitch, ValueMapping.linear(-48, 48), semitones, "Pitch"),
        sweep: parameter.createParameter(box.sweep, ValueMapping.exponential(0.0005, 2), seconds, "Sweep"),
        decay: parameter.createParameter(box.decay, ValueMapping.exponential(0.005, 4), seconds, "Decay"),
        curve: parameter.createParameter(box.curve, ValueMapping.bipolar(), percent, "Curve", 0.5),
        noise: parameter.createParameter(box.noise, ValueMapping.unipolar(), percent, "Noise"),
        drive: parameter.createParameter(box.drive, ValueMapping.linear(0, 36), decibel, "Drive"),
        volume: parameter.createParameter(box.volume, ValueMapping.linear(-36, 6), decibel, "Volume"),
        velocity: parameter.createParameter(box.velocity, ValueMapping.unipolar(), percent, "Velocity"),
        play: parameter.createParameter(box.play, OpenDrum.choice(OpenDrum.PlayModes),
            StringMapping.indices("", OpenDrum.PlayModes), "Mode")
    } as const
}

export class OpenDrumPercDeviceBoxAdapter
    extends OpenDrumDeviceBoxAdapter<OpenDrumPercDeviceBox, ReturnType<typeof wrap>> {
    constructor(context: BoxAdaptersContext, box: OpenDrumPercDeviceBox) {
        super(context, box, DeviceManualUrls.OpenDrumPerc, wrap)
    }
}
