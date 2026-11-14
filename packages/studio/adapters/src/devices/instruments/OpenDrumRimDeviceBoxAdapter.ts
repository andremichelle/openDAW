import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumRimDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {OpenDrum} from "./OpenDrum"
import {OpenDrumDeviceBoxAdapter} from "./OpenDrumDeviceBoxAdapter"

const wrap = (parameter: ParameterAdapterSet, box: OpenDrumRimDeviceBox) => {
    const {decibel, hertz, percent, seconds} = OpenDrum.Strings
    return {
        tune: parameter.createParameter(box.tune, ValueMapping.exponential(100, 4000), hertz, "Tune"),
        ratio: parameter.createParameter(box.ratio, ValueMapping.linear(1, 5),
            StringMapping.numeric({fractionDigits: 2}), "Ratio"),
        balance: parameter.createParameter(box.balance, ValueMapping.unipolar(), percent, "Balance"),
        high: parameter.createParameter(box.high, ValueMapping.unipolar(), percent, "High Level"),
        highRatio: parameter.createParameter(box.highRatio, ValueMapping.linear(1, 12),
            StringMapping.numeric({fractionDigits: 2}), "High Ratio"),
        ring: parameter.createParameter(box.ring, ValueMapping.exponential(0.005, 1), seconds, "Ring"),
        ringHigh: parameter.createParameter(box.ringHigh, ValueMapping.exponential(0.005, 1), seconds, "High Ring"),
        decay: parameter.createParameter(box.decay, ValueMapping.exponential(0.002, 0.5), seconds, "Decay"),
        punch: parameter.createParameter(box.punch, ValueMapping.bipolar(), percent, "Punch", 0.5),
        drive: parameter.createParameter(box.drive, ValueMapping.linear(0, 36), decibel, "Drive"),
        hard: parameter.createParameter(box.hard, ValueMapping.unipolar(), percent, "Hard"),
        click: parameter.createParameter(box.click, ValueMapping.unipolar(), percent, "Click"),
        swell: parameter.createParameter(box.swell, ValueMapping.linear(0, 8),
            StringMapping.numeric({fractionDigits: 1}), "Swell"),
        cut: parameter.createParameter(box.cut, ValueMapping.exponential(20, 4000), hertz, "Cut"),
        restart: parameter.createParameter(box.restart, OpenDrum.choice(OpenDrum.OffOn),
            StringMapping.indices("", OpenDrum.OffOn), "Restart"),
        volume: parameter.createParameter(box.volume, ValueMapping.linear(-36, 6), decibel, "Volume"),
        velocity: parameter.createParameter(box.velocity, ValueMapping.unipolar(), percent, "Velocity"),
        play: parameter.createParameter(box.play, OpenDrum.choice(OpenDrum.PlayModes),
            StringMapping.indices("", OpenDrum.PlayModes), "Mode")
    } as const
}

export class OpenDrumRimDeviceBoxAdapter
    extends OpenDrumDeviceBoxAdapter<OpenDrumRimDeviceBox, ReturnType<typeof wrap>> {
    constructor(context: BoxAdaptersContext, box: OpenDrumRimDeviceBox) {
        super(context, box, DeviceManualUrls.OpenDrumRim, wrap)
    }
}
