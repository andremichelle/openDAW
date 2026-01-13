import {byte, Comparator, int, safeExecute} from "@moises-ai/lib-std"
import {Event} from "./Event"
import {ControlType} from "./ControlType"
import {MidiEventVisitor} from "./MidiEventVisitor"
import {MidiFileDecoder} from "./MidiFileDecoder"

export class ControlEvent implements Event<ControlType> {
    static readonly Comparator: Comparator<ControlEvent> = (a, b) => a.ticks - b.ticks

    constructor(readonly ticks: int, readonly type: ControlType, readonly param0: byte, readonly param1: byte) {}

    static decode(decoder: MidiFileDecoder, type: int, ticks: int): ControlEvent | null {
        switch (type) {
            case ControlType.NOTE_ON:
            case ControlType.NOTE_OFF:
            case ControlType.CONTROLLER:
            case ControlType.PITCH_BEND:
            case ControlType.NOTE_AFTER_TOUCH:
                return new ControlEvent(ticks, type, decoder.readByte(), decoder.readByte())
            case ControlType.PROGRAM_CHANGE:
            case ControlType.CHANNEL_AFTER_TOUCH:
                return new ControlEvent(ticks, type, decoder.readByte(), 0)
        }
        {
            // else ignore the message
            let c: int
            do {
                c = decoder.readByte() & 0xff
            } while (c < 0x80)
            decoder.skip(-1)
        }
        return null
    }

    accept(visitor: MidiEventVisitor): void {
        switch (this.type) {
            case ControlType.NOTE_ON: {
                if (0 === this.param1) {
                    safeExecute(visitor.noteOff, this.param0)
                } else {
                    safeExecute(visitor.noteOn, this.param0, this.param1 / 127.0)
                }
                break
            }
            case ControlType.NOTE_OFF: {
                safeExecute(visitor.noteOff, this.param0)
                break
            }
            case ControlType.PITCH_BEND: {
                const p1 = this.param0 & 0x7f
                const p2 = this.param1 & 0x7f
                const value = p1 | (p2 << 7)
                safeExecute(visitor.pitchBend, 8192 >= value ? value / 8192.0 - 1.0 : (value - 8191) / 8192.0)
                break
            }
            case ControlType.CONTROLLER: {
                safeExecute(visitor.controller, this.param0, this.param1 / 127.0)
                break
            }
            default: {break}
        }
    }

    toString(): string {
        return `ControlEvent{ticks: ${this.ticks}, type: ${this.type}, param0: ${this.param0}, param1: ${this.param1}}`
    }
}