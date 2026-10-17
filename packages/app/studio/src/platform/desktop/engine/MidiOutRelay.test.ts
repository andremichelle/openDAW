import {describe, expect, it} from "vitest"
import {MIDISender} from "../../../../../../studio/core-processors/src/MIDISender"
import {LinkedPort, MidiOutRelay} from "./MidiOutRelay"

// the engine's own MIDISender writes into the relay's ring, as the wasm MIDI drain does after `setupMIDI`
const setup = (relay: MidiOutRelay): MIDISender => {
    const studioBuffer = new SharedArrayBuffer(64)
    const args = [{value: new LinkedPort(6) as unknown}, {value: studioBuffer as unknown}]
    relay.intercept({message: {func: "setupMIDI", args}}, buffer => buffer === studioBuffer ? 9 : -1)
    expect(relay.target).toEqual({port: 6, buffer: 9})
    expect(args[1].value).toBe(relay.buffer)
    return new MIDISender(args[0].value as MessagePort, args[1].value as SharedArrayBuffer)
}

describe("MidiOutRelay", () => {
    it("hands the engine a local ring and reads back every event with its device and time", () => {
        const relay = new MidiOutRelay()
        const sender = setup(relay)
        sender.send("out-a", new Uint8Array([0x90, 60, 100]), 3)
        sender.send("out-b", new Uint8Array([0xC0, 5]), 7)
        sender.send("out-a", new Uint8Array([0xF8]), 0)
        expect(relay.take()).toEqual([
            {deviceId: "out-a", data: new Uint8Array([0x90, 60, 100]), timeMs: 3},
            {deviceId: "out-b", data: new Uint8Array([0xC0, 5]), timeMs: 7},
            {deviceId: "out-a", data: new Uint8Array([0xF8]), timeMs: 0}
        ])
        expect(relay.take()).toEqual([])
    })

    it("keeps reading across the ring's wrap", () => {
        const relay = new MidiOutRelay()
        const sender = setup(relay)
        for (let round = 0; round < 5; round++) {
            for (let index = 0; index < 1500; index++) {sender.send("out", new Uint8Array([0x80, index & 0x7F, 0]), index)}
            const events = relay.take()
            expect(events.length).toBe(1500)
            expect(events[1499].timeMs).toBe(1499)
        }
    })

    it("leaves other commands and a setupMIDI without a linked port alone", () => {
        const relay = new MidiOutRelay()
        const args = [{value: {} as unknown}, {value: new SharedArrayBuffer(8) as unknown}]
        relay.intercept({message: {func: "setupMIDI", args}}, () => 1)
        relay.intercept({message: {func: "play", args: []}}, () => 1)
        expect(relay.target).toBeNull()
    })
})
