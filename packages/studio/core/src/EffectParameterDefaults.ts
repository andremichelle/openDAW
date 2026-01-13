import {RevampDeviceBox} from "@moises-ai/studio-boxes"
import {INVERSE_SQRT_2} from "@moises-ai/lib-std"

export namespace EffectParameterDefaults {
    export const defaultRevampDeviceBox = (box: RevampDeviceBox) => {
        box.label.setValue("Revamp")
        box.highPass.frequency.setInitValue(40.0)
        box.highPass.order.setInitValue(1)
        box.highPass.q.setInitValue(Math.SQRT1_2)
        box.highPass.enabled.setInitValue(true)
        box.lowShelf.frequency.setInitValue(80.0)
        box.lowShelf.gain.setInitValue(6)
        box.lowBell.frequency.setInitValue(120.0)
        box.lowBell.gain.setInitValue(6)
        box.lowBell.q.setInitValue(INVERSE_SQRT_2)
        box.midBell.frequency.setInitValue(640.0)
        box.midBell.q.setInitValue(INVERSE_SQRT_2)
        box.midBell.gain.setInitValue(6)
        box.highBell.frequency.setInitValue(3600.0)
        box.highBell.q.setInitValue(INVERSE_SQRT_2)
        box.highBell.gain.setInitValue(6)
        box.highShelf.frequency.setInitValue(10000.0)
        box.highShelf.gain.setInitValue(6)
        box.lowPass.frequency.setInitValue(15000.0)
        box.lowPass.order.setInitValue(1)
        box.lowPass.q.setInitValue(Math.SQRT1_2)
    }
}