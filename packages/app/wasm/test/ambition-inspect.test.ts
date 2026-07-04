// Inspection of "/tmp/ambition.odb": the send/return topology — AuxSendBoxes (source unit -> targetBus, gain/pan),
// AudioBusBoxes (return channels), and which units output where.
import {describe, it} from "vitest"
import {existsSync, readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {decodeBundle} from "../src/bundle"

describe.skipIf(!existsSync("/tmp/ambition.odb"))("ambition inspect", () => {
    it("dumps send/return topology", async () => {
        const buffer = readFileSync("/tmp/ambition.odb")
        const {boxGraph} = await decodeBundle(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
        const counts = new Map<string, number>()
        for (const box of boxGraph.boxes()) {counts.set(box.name, (counts.get(box.name) ?? 0) + 1)}
        console.log("BOX COUNTS", JSON.stringify(Object.fromEntries([...counts].filter(([name]) =>
            /Unit|Bus|AuxSend|Send/.test(name))), null, 0))
        console.log("TOTAL BOX TYPES", counts.size)
        // AuxSendBoxes: their targetBus + sendGain/sendPan.
        for (const box of boxGraph.boxes()) {
            if (box.name !== "AuxSendBox") {continue}
            const anyBox = box as unknown as {
                sendGain: {getValue(): number}, sendPan: {getValue(): number}
                targetBus: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}
            }
            const target = anyBox.targetBus.targetAddress.unwrapOrNull()
            console.log("AUX SEND", UUID.toString(box.address.uuid).slice(0, 8),
                "-> bus", target === null ? "UNRESOLVED" : UUID.toString(target.uuid as UUID.Bytes).slice(0, 8),
                "gain", anyBox.sendGain.getValue().toFixed(2), "pan", anyBox.sendPan.getValue().toFixed(2))
        }
        const short = (uuid: Uint8Array) => UUID.toString(uuid as UUID.Bytes).slice(0, 8)
        const ptr = (field: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}) => {
            const addr = field.targetAddress.unwrapOrNull()
            return addr === null ? "UNSET" : `${short(addr.uuid)}[${Array.from(addr.fieldKeys).join(",")}]`
        }
        // Each AudioUnitBox: its type(1), volume/pan/mute, output(25) target, and what occupies input host (22).
        for (const box of boxGraph.boxes()) {
            if (box.name !== "AudioUnitBox") {continue}
            const unit = box as unknown as {
                type: {getValue(): string}, output: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}
                mute: {getValue(): boolean}
            }
            console.log("UNIT", short(box.address.uuid), "type", unit.type.getValue(), "mute", unit.mute.getValue(),
                "output ->", ptr(unit.output))
        }
        // Each AudioBusBox: label + output(2) target (the bus-unit input it feeds).
        for (const box of boxGraph.boxes()) {
            if (box.name !== "AudioBusBox") {continue}
            const bus = box as unknown as {
                label: {getValue(): string}, output: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}
            }
            console.log("BUS", short(box.address.uuid), "label", JSON.stringify(bus.label.getValue()), "output ->", ptr(bus.output))
        }
    }, 60000)
})
