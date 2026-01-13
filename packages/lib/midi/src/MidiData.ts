import {byte, isNull, Nullable, safeExecute} from "@moises-ai/lib-std"
import {MidiEventVisitor} from "./MidiEventVisitor"
import {ppqn} from "@moises-ai/lib-dsp"

export namespace MidiData {
    export enum Command {
        NoteOn = 0x90, NoteOff = 0x80, PitchBend = 0xE0, Controller = 0xB0,
        Start = 0xFA, Continue = 0xFB, Stop = 0xFC, Clock = 0xF8, Position = 0xF2
    }

    export const readCommand = (data: Uint8Array) => data[0] & 0xF0
    export const readChannel = (data: Uint8Array) => data[0] & 0x0F
    export const readParam1 = (d: Uint8Array) => d.length > 1 ? d[1] & 0xFF : 0
    export const readParam2 = (d: Uint8Array) => d.length > 2 ? d[2] & 0xFF : 0
    export const readPitch = (d: Uint8Array) => d[1]
    export const readVelocity = (d: Uint8Array) => d[2] / 127.0

    export const isNoteOn = (d: Uint8Array) => readCommand(d) === Command.NoteOn && readVelocity(d) > 0
    export const isNoteOff = (d: Uint8Array) => readCommand(d) === Command.NoteOff || (readCommand(d) === Command.NoteOn && readVelocity(d) === 0)
    export const isPitchWheel = (d: Uint8Array) => readCommand(d) === Command.PitchBend
    export const isController = (d: Uint8Array) => readCommand(d) === Command.Controller
    export const isClock = (d: Uint8Array) => d[0] === Command.Clock
    export const isStart = (d: Uint8Array) => d[0] === Command.Start
    export const isContinue = (d: Uint8Array) => d[0] === Command.Continue
    export const isStop = (d: Uint8Array) => d[0] === Command.Stop
    export const isPosition = (d: Uint8Array) => d[0] === Command.Position

    export const asPitchBend = (d: Uint8Array) => {
        const p1 = readParam1(d) & 0x7F, p2 = readParam2(d) & 0x7F, v = p1 | (p2 << 7)
        return 8192 >= v ? v / 8192 - 1 : (v - 8191) / 8192
    }
    export const asValue = (d: Uint8Array) => {
        const v = readParam2(d)
        return v > 64 ? 0.5 + (v - 63) / 128 : v < 64 ? v / 128 : 0.5
    }

    export const Clock = new Uint8Array([Command.Clock])
    export const Start = new Uint8Array([Command.Start])
    export const Continue = new Uint8Array([Command.Continue])
    export const Stop = new Uint8Array([Command.Stop])

    export const noteOn = (ch: byte, note: byte, vel: byte) => new Uint8Array([Command.NoteOn | ch, note, vel])
    export const noteOff = (ch: byte, note: byte) => new Uint8Array([Command.NoteOff | ch, note, 0])
    export const control = (ch: byte, ctrl: byte, val: byte) => new Uint8Array([Command.Controller | ch, ctrl & 0x7F, val & 0x7F])
    export const position = (lsb: byte, msb: byte) => new Uint8Array([Command.Position, lsb & 0x7F, msb & 0x7F])
    export const positionInPPQN = (pulses: ppqn) => {
        // MIDI Song Position Pointer unit = 6 MIDI clocks = 1/16 note
        const midiBeats = Math.floor(pulses / 96) // 960 / 10
        const lsb = midiBeats & 0x7F
        const msb = (midiBeats >> 7) & 0x7F
        return new Uint8Array([Command.Position, lsb, msb])
    }

    export const accept = (data: Nullable<Uint8Array>, v: MidiEventVisitor): void => {
        if (isNull(data)) return
        if (isNoteOn(data)) safeExecute(v.noteOn, readPitch(data), readVelocity(data))
        else if (isNoteOff(data)) safeExecute(v.noteOff, readPitch(data))
        else if (isPitchWheel(data)) safeExecute(v.pitchBend, asPitchBend(data))
        else if (isController(data)) safeExecute(v.controller, readParam1(data), readParam2(data) / 127)
        else if (isClock(data)) safeExecute(v.clock)
        else if (isStart(data)) safeExecute(v.start)
        else if (isContinue(data)) safeExecute(v.continue)
        else if (isStop(data)) safeExecute(v.stop)
        else if (isPosition(data)) safeExecute(v.songPos, readParam1(data) | (readParam2(data) << 7))
    }

    export const debug = (data: Nullable<Uint8Array>): string => {
        if (data === null) return "null"
        if (isNoteOn(data)) return `NoteOn #${readChannel(data)} ${readPitch(data)} : ${readVelocity(data).toFixed(2)}`
        if (isNoteOff(data)) return `NoteOff #${readChannel(data)} ${readPitch(data)}`
        if (isPitchWheel(data)) return `PitchWheel #${readChannel(data)} ${asPitchBend(data)}`
        if (isController(data)) return `Control #${readChannel(data)} ${asValue(data)}`
        if (isClock(data)) return "Clock"
        if (isStart(data)) return "Start"
        if (isContinue(data)) return "Continue"
        if (isStop(data)) return "Stop"
        if (isPosition(data)) return `SongPosition ${readParam1(data) | (readParam2(data) << 7)}`
        return "Unknown"
    }
}