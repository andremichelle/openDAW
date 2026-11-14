import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumCymbalDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {OpenDrum} from "./OpenDrum"
import {OpenDrumDeviceBoxAdapter} from "./OpenDrumDeviceBoxAdapter"

const wrap = (parameter: ParameterAdapterSet, box: OpenDrumCymbalDeviceBox) => {
    const {decibel, percent, seconds} = OpenDrum.Strings
    return {
        tune: parameter.createParameter(box.tune, ValueMapping.exponential(0.25, 4),
            StringMapping.numeric({fractionDigits: 2}), "Tune"),
        tone: parameter.createParameter(box.tone, ValueMapping.unipolar(), percent, "Tone"),
        attack: parameter.createParameter(box.attack, ValueMapping.linear(0, 2), seconds, "Attack"),
        decay: parameter.createParameter(box.decay, ValueMapping.exponential(0.05, 8), seconds, "Decay"),
        volume: parameter.createParameter(box.volume, ValueMapping.linear(-36, 6), decibel, "Volume"),
        velocity: parameter.createParameter(box.velocity, ValueMapping.unipolar(), percent, "Velocity"),
        play: parameter.createParameter(box.play, OpenDrum.choice(OpenDrum.PlayModes),
            StringMapping.indices("", OpenDrum.PlayModes), "Mode")
    } as const
}

export class OpenDrumCymbalDeviceBoxAdapter
    extends OpenDrumDeviceBoxAdapter<OpenDrumCymbalDeviceBox, ReturnType<typeof wrap>> {
    constructor(context: BoxAdaptersContext, box: OpenDrumCymbalDeviceBox) {
        super(context, box, DeviceManualUrls.OpenDrumCymbal, wrap)
    }
}
