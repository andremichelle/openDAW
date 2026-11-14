import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumHatDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {OpenDrum} from "./OpenDrum"
import {OpenDrumDeviceBoxAdapter} from "./OpenDrumDeviceBoxAdapter"

const wrap = (parameter: ParameterAdapterSet, box: OpenDrumHatDeviceBox) => {
    const {decibel, hertz, percent, seconds} = OpenDrum.Strings
    return {
        tune: parameter.createParameter(box.tune, ValueMapping.exponential(0.25, 4),
            StringMapping.numeric({fractionDigits: 2}), "Tune"),
        color: parameter.createParameter(box.color, ValueMapping.exponential(200, 16000), hertz, "Color"),
        hold: parameter.createParameter(box.hold, ValueMapping.linear(0, 0.5), seconds, "Hold"),
        decay: parameter.createParameter(box.decay, ValueMapping.exponential(0.005, 4), seconds, "Decay"),
        spread: parameter.createParameter(box.spread, ValueMapping.bipolar(), percent, "Spread", 0.5),
        ring: parameter.createParameter(box.ring, ValueMapping.unipolar(), percent, "Ring"),
        reso: parameter.createParameter(box.reso, ValueMapping.unipolar(), percent, "Reso"),
        curve: parameter.createParameter(box.curve, ValueMapping.bipolar(), percent, "Curve", 0.5),
        volume: parameter.createParameter(box.volume, ValueMapping.linear(-36, 6), decibel, "Volume"),
        velocity: parameter.createParameter(box.velocity, ValueMapping.unipolar(), percent, "Velocity"),
        play: parameter.createParameter(box.play, OpenDrum.choice(OpenDrum.PlayModes),
            StringMapping.indices("", OpenDrum.PlayModes), "Mode"),
        panning: parameter.createParameter(box.panning, ValueMapping.bipolar(), StringMapping.panning, "Pan", 0.5)
    } as const
}

export class OpenDrumHatDeviceBoxAdapter
    extends OpenDrumDeviceBoxAdapter<OpenDrumHatDeviceBox, ReturnType<typeof wrap>> {
    constructor(context: BoxAdaptersContext, box: OpenDrumHatDeviceBox) {
        super(context, box, DeviceManualUrls.OpenDrumHat, wrap)
    }
}
