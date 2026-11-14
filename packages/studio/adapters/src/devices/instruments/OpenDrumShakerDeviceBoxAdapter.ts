import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumShakerDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {OpenDrum} from "./OpenDrum"
import {OpenDrumDeviceBoxAdapter} from "./OpenDrumDeviceBoxAdapter"

const wrap = (parameter: ParameterAdapterSet, box: OpenDrumShakerDeviceBox) => {
    const {decibel, hertz, percent, seconds} = OpenDrum.Strings
    return {
        color: parameter.createParameter(box.color, ValueMapping.exponential(200, 16000), hertz, "Color"),
        attack: parameter.createParameter(box.attack, ValueMapping.linear(0, 0.2), seconds, "Attack"),
        decay: parameter.createParameter(box.decay, ValueMapping.exponential(0.002, 2), seconds, "Decay"),
        curve: parameter.createParameter(box.curve, ValueMapping.bipolar(), percent, "Curve", 0.5),
        volume: parameter.createParameter(box.volume, ValueMapping.linear(-36, 6), decibel, "Volume"),
        velocity: parameter.createParameter(box.velocity, ValueMapping.unipolar(), percent, "Velocity"),
        play: parameter.createParameter(box.play, OpenDrum.choice(OpenDrum.PlayModes),
            StringMapping.indices("", OpenDrum.PlayModes), "Mode"),
        panning: parameter.createParameter(box.panning, ValueMapping.bipolar(), StringMapping.panning, "Pan", 0.5)
    } as const
}

export class OpenDrumShakerDeviceBoxAdapter
    extends OpenDrumDeviceBoxAdapter<OpenDrumShakerDeviceBox, ReturnType<typeof wrap>> {
    constructor(context: BoxAdaptersContext, box: OpenDrumShakerDeviceBox) {
        super(context, box, DeviceManualUrls.OpenDrumShaker, wrap)
    }
}
