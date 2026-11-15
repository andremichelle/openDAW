import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumBellDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {OpenDrum} from "./OpenDrum"
import {OpenDrumDeviceBoxAdapter} from "./OpenDrumDeviceBoxAdapter"

const wrap = (parameter: ParameterAdapterSet, box: OpenDrumBellDeviceBox) => {
    const {decibel, hertz, percent, seconds} = OpenDrum.Strings
    return {
        tune: parameter.createParameter(box.tune, ValueMapping.exponential(50, 4000), hertz, "Tune"),
        ratio: parameter.createParameter(box.ratio, ValueMapping.linear(1, 4),
            StringMapping.numeric({fractionDigits: 3}), "Ratio"),
        balance: parameter.createParameter(box.balance, ValueMapping.unipolar(), percent, "Balance"),
        color: parameter.createParameter(box.color, ValueMapping.exponential(100, 16000), hertz, "Color"),
        strike: parameter.createParameter(box.strike, ValueMapping.unipolar(), percent, "Strike"),
        decay: parameter.createParameter(box.decay, ValueMapping.exponential(0.01, 4), seconds, "Decay"),
        volume: parameter.createParameter(box.volume, ValueMapping.linear(-36, 6), decibel, "Volume"),
        velocity: parameter.createParameter(box.velocity, ValueMapping.unipolar(), percent, "Velocity"),
        play: parameter.createParameter(box.play, OpenDrum.choice(OpenDrum.PlayModes),
            StringMapping.indices("", OpenDrum.PlayModes), "Mode"),
        panning: parameter.createParameter(box.panning, ValueMapping.bipolar(), StringMapping.panning, "Pan", 0.5)
    } as const
}

export class OpenDrumBellDeviceBoxAdapter
    extends OpenDrumDeviceBoxAdapter<OpenDrumBellDeviceBox, ReturnType<typeof wrap>> {
    constructor(context: BoxAdaptersContext, box: OpenDrumBellDeviceBox) {
        super(context, box, DeviceManualUrls.OpenDrumBell, wrap)
    }
}
