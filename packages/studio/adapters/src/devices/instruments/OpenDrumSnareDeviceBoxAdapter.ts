import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumSnareDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {OpenDrum} from "./OpenDrum"
import {OpenDrumDeviceBoxAdapter} from "./OpenDrumDeviceBoxAdapter"

const wrap = (parameter: ParameterAdapterSet, box: OpenDrumSnareDeviceBox) => {
    const {decibel, hertz, percent, seconds, semitones} = OpenDrum.Strings
    return {
        tune: parameter.createParameter(box.tune, ValueMapping.exponential(80, 600), hertz, "Tune"),
        ratio: parameter.createParameter(box.ratio, ValueMapping.linear(1, 3),
            StringMapping.numeric({fractionDigits: 2}), "Ratio"),
        balance: parameter.createParameter(box.balance, ValueMapping.unipolar(), percent, "Balance"),
        pitch: parameter.createParameter(box.pitch, ValueMapping.linear(0, 24), semitones, "Pitch"),
        sweep: parameter.createParameter(box.sweep, ValueMapping.exponential(0.001, 0.1), seconds, "Sweep"),
        decay: parameter.createParameter(box.decay, ValueMapping.exponential(0.02, 2), seconds, "Decay"),
        punch: parameter.createParameter(box.punch, ValueMapping.bipolar(), percent, "Punch", 0.5),
        shape: parameter.createParameter(box.shape, ValueMapping.unipolar(), percent, "Shape"),
        level: parameter.createParameter(box.level, ValueMapping.linear(-48, -3), decibel, "Level"),
        wireDecay: parameter.createParameter(box.wireDecay, ValueMapping.exponential(0.02, 2),
            seconds, "Noise Decay"),
        width: parameter.createParameter(box.width, ValueMapping.unipolar(), percent, "Width"),
        curve: parameter.createParameter(box.curve, ValueMapping.bipolar(), percent, "Curve", 0.5),
        click: parameter.createParameter(box.click, ValueMapping.unipolar(), percent, "Click"),
        tone: parameter.createParameter(box.tone, ValueMapping.exponential(200, 16000), hertz, "Tone"),
        skin: parameter.createParameter(box.skin, ValueMapping.unipolar(), percent, "Skin"),
        drive: parameter.createParameter(box.drive, ValueMapping.linear(0, 36), decibel, "Drive"),
        volume: parameter.createParameter(box.volume, ValueMapping.linear(-36, 6), decibel, "Volume"),
        velocity: parameter.createParameter(box.velocity, ValueMapping.unipolar(), percent, "Velocity"),
        play: parameter.createParameter(box.play, OpenDrum.choice(OpenDrum.PlayModes),
            StringMapping.indices("", OpenDrum.PlayModes), "Mode"),
        panning: parameter.createParameter(box.panning, ValueMapping.bipolar(), StringMapping.panning, "Pan", 0.5)
    } as const
}

export class OpenDrumSnareDeviceBoxAdapter
    extends OpenDrumDeviceBoxAdapter<OpenDrumSnareDeviceBox, ReturnType<typeof wrap>> {
    constructor(context: BoxAdaptersContext, box: OpenDrumSnareDeviceBox) {
        super(context, box, DeviceManualUrls.OpenDrumSnare, wrap)
    }
}
