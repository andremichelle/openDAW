import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {OpenDrumClapDeviceBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {OpenDrum} from "./OpenDrum"
import {OpenDrumDeviceBoxAdapter} from "./OpenDrumDeviceBoxAdapter"

const wrap = (parameter: ParameterAdapterSet, box: OpenDrumClapDeviceBox) => {
    const {decibel, hertz, percent, seconds} = OpenDrum.Strings
    return {
        hands: parameter.createParameter(box.hands, ValueMapping.linearInteger(1, 8),
            StringMapping.numeric({fractionDigits: 0}), "Hands"),
        gap: parameter.createParameter(box.gap, ValueMapping.linear(0, 0.04), seconds, "Gap"),
        last: parameter.createParameter(box.last, ValueMapping.linear(0.3, 1.5),
            StringMapping.numeric({fractionDigits: 2}), "Last"),
        spread: parameter.createParameter(box.spread, ValueMapping.unipolar(), percent, "Spread"),
        attack: parameter.createParameter(box.attack, ValueMapping.linear(0, 0.005), seconds, "Attack"),
        decay: parameter.createParameter(box.decay, ValueMapping.exponential(0.002, 0.2), seconds, "Decay"),
        snap: parameter.createParameter(box.snap, ValueMapping.unipolar(), percent, "Snap"),
        drive: parameter.createParameter(box.drive, ValueMapping.linear(0, 36), decibel, "Drive"),
        tone: parameter.createParameter(box.tone, ValueMapping.exponential(300, 8000), hertz, "Tone"),
        resonance: parameter.createParameter(box.resonance, ValueMapping.unipolar(), percent, "Reso"),
        room: parameter.createParameter(box.room, ValueMapping.linear(-48, 0), decibel, "Room Level"),
        roomDecay: parameter.createParameter(box.roomDecay, ValueMapping.exponential(0.02, 2),
            seconds, "Room Decay"),
        tail: parameter.createParameter(box.tail, ValueMapping.unipolar(), percent, "Tail"),
        volume: parameter.createParameter(box.volume, ValueMapping.linear(-36, 6), decibel, "Volume"),
        velocity: parameter.createParameter(box.velocity, ValueMapping.unipolar(), percent, "Velocity"),
        play: parameter.createParameter(box.play, OpenDrum.choice(OpenDrum.PlayModes),
            StringMapping.indices("", OpenDrum.PlayModes), "Mode"),
        panning: parameter.createParameter(box.panning, ValueMapping.bipolar(), StringMapping.panning, "Pan", 0.5)
    } as const
}

export class OpenDrumClapDeviceBoxAdapter
    extends OpenDrumDeviceBoxAdapter<OpenDrumClapDeviceBox, ReturnType<typeof wrap>> {
    constructor(context: BoxAdaptersContext, box: OpenDrumClapDeviceBox) {
        super(context, box, DeviceManualUrls.OpenDrumClap, wrap)
    }
}
