import {clamp, int, isDefined, Option, unitValue} from "@opendaw/lib-std"
import {MIDITakeover} from "./MIDITakeover"
import {MIDIEncoding} from "./MIDIEncoding"
import {MIDIMappingState} from "./MIDIMappingState"

export namespace MIDIMappingTransform {
    export type Settings = {
        min: unitValue
        max: unitValue
        takeover: MIDITakeover
        encoding: MIDIEncoding
    }

    const ControllerStep = 1.0 / 128.0
    const RelativeStep = 1.0 / 128.0
    const Tolerance = 1e-6

    const isUntouched = (state: MIDIMappingState, current: unitValue): boolean =>
        isDefined(state.lastApplied) && Math.abs(state.lastApplied - current) <= Tolerance

    // same curve as MidiData.asValue
    const toController = (value: int): unitValue =>
        value > 64 ? 0.5 + (value - 63) / 128.0 : value < 64 ? value / 128.0 : 0.5

    export const decodeRelative = (encoding: MIDIEncoding, value: int): int => {
        switch (encoding) {
            case MIDIEncoding.TwosComplement:
                return value < 64 ? value : value - 128
            case MIDIEncoding.BinaryOffset:
                return value - 64
            case MIDIEncoding.SignBit:
                return (value & 0x40) === 0 ? value & 0x3F : -(value & 0x3F)
            default:
                return 0
        }
    }

    export const apply = (settings: Settings, state: MIDIMappingState,
                          value: int, current: unitValue): Option<unitValue> => {
        const {min, max, takeover, encoding} = settings
        const span = max - min
        if (encoding !== MIDIEncoding.Absolute) {
            const base = isDefined(state.relativeValue) && isUntouched(state, current) ? state.relativeValue : current
            const next = clamp(base + decodeRelative(encoding, value) * RelativeStep * span,
                Math.min(min, max), Math.max(min, max))
            state.relativeValue = next
            return Option.wrap(next)
        }
        const controller = toController(value)
        const last = state.lastController
        state.lastController = controller
        if (takeover === MIDITakeover.Jump) {return Option.wrap(min + controller * span)}
        const position = span === 0.0 ? 0.0 : (current - min) / span
        if (takeover === MIDITakeover.Pickup) {
            if (isDefined(state.lastApplied) && !isUntouched(state, current)) {state.pickedUp = false}
            if (!state.pickedUp) {
                const near = Math.abs(controller - position) <= ControllerStep
                const crossed = isDefined(last) && (last - position) * (controller - position) <= 0.0
                if (!near && !crossed) {return Option.None}
                state.pickedUp = true
            }
            const next = min + controller * span
            state.lastApplied = next
            return Option.wrap(next)
        }
        if (!isDefined(last) || last === controller) {return Option.None}
        const from = clamp(position, 0.0, 1.0)
        const moved = controller > last
            ? from + (1.0 - from) * (controller - last) / (1.0 - last)
            : from - from * (last - controller) / last
        return Option.wrap(min + clamp(moved, 0.0, 1.0) * span)
    }
}
