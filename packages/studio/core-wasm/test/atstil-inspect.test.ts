// Inspection of "~/Downloads/atstil.od": the user reports it sounds VERY different in TS vs WASM. Dump the
// topology (units, devices, buses, sends, tracks, regions/clips, samples) to localize where they could diverge.
import * as path from "node:path"
import {describe, it} from "vitest"
import {existsSync, readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"

const FILE = path.resolve(__dirname, "../../../../test-files/atstil.od")

describe.skipIf(!existsSync(FILE))("atstil inspect", () => {
    it("dumps topology", async () => {
        const buffer = readFileSync(FILE)
        const {boxGraph} = ProjectSkeleton.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
        const counts = new Map<string, number>()
        for (const box of boxGraph.boxes()) {counts.set(box.name, (counts.get(box.name) ?? 0) + 1)}
        console.log("BOX COUNTS", JSON.stringify(Object.fromEntries([...counts].sort()), null, 0))
        const short = (uuid: Uint8Array) => UUID.toString(uuid as UUID.Bytes).slice(0, 8)
        const ptr = (field: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}) => {
            const addr = field.targetAddress.unwrapOrNull()
            return addr === null ? "UNSET" : `${short(addr.uuid)}[${Array.from(addr.fieldKeys).join(",")}]`
        }
        for (const box of boxGraph.boxes()) {
            if (box.name !== "AudioUnitBox") {continue}
            const unit = box as unknown as {
                type: {getValue(): string}, mute: {getValue(): boolean}, solo: {getValue(): boolean}
                volume: {getValue(): number}, output: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}
            }
            console.log("UNIT", short(box.address.uuid), "type", unit.type.getValue(), "mute", unit.mute.getValue(),
                "solo", unit.solo.getValue(), "vol", unit.volume.getValue().toFixed(2), "output ->", ptr(unit.output))
        }
        for (const box of boxGraph.boxes()) {
            const host = (box as unknown as {host?: {targetAddress?: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}}).host
            const addr = host?.targetAddress?.unwrapOrNull()
            if (addr === undefined || addr === null) {continue}
            const keys = Array.from(addr.fieldKeys).join(",")
            if (keys === "22" || keys === "23" || keys === "24") {
                const label = (box as unknown as {label?: {getValue(): string}}).label?.getValue() ?? ""
                console.log("DEVICE", box.name, short(box.address.uuid), "on unit", short(addr.uuid), `[${keys}]`, JSON.stringify(label))
            }
        }
        for (const box of boxGraph.boxes()) {
            if (box.name !== "AudioBusBox") {continue}
            const bus = box as unknown as {label: {getValue(): string}}
            console.log("BUS", short(box.address.uuid), JSON.stringify(bus.label.getValue()))
        }
        for (const box of boxGraph.boxes()) {
            if (box.name !== "AuxSendBox") {continue}
            const send = box as unknown as {
                sendGain: {getValue(): number}, sendPan: {getValue(): number}
                targetBus: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}
            }
            console.log("AUX SEND", short(box.address.uuid), "->", ptr(send.targetBus),
                "gain", send.sendGain.getValue().toFixed(2), "pan", send.sendPan.getValue().toFixed(2))
        }
        for (const box of boxGraph.boxes()) {
            if (box.name !== "TrackBox") {continue}
            const track = box as unknown as {
                type: {getValue(): number}, target: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array, fieldKeys: ArrayLike<number>} | null}}
                regions: {pointerHub: {incoming(): ReadonlyArray<unknown>}}, clips: {pointerHub: {incoming(): ReadonlyArray<unknown>}}
            }
            console.log("TRACK", short(box.address.uuid), "type", track.type.getValue(), "target ->", ptr(track.target),
                "regions", track.regions.pointerHub.incoming().length, "clips", track.clips.pointerHub.incoming().length)
        }
        for (const box of boxGraph.boxes()) {
            if (box.name !== "AudioFileBox") {continue}
            const file = box as unknown as {fileName: {getValue(): string}}
            console.log("AUDIO FILE", UUID.toString(box.address.uuid), JSON.stringify(file.fileName.getValue()))
        }
        for (const box of boxGraph.boxes()) {
            if (box.name !== "TimelineBox") {continue}
            const timeline = box as unknown as {
                loopArea: {from: {getValue(): number}, to: {getValue(): number}, enabled: {getValue(): boolean}}
                bpm: {getValue(): number}, signature: {nominator: {getValue(): number}, denominator: {getValue(): number}}
            }
            console.log("TIMELINE bpm", timeline.bpm.getValue(), "sig", timeline.signature.nominator.getValue(),
                "/", timeline.signature.denominator.getValue(), "loop", timeline.loopArea.enabled.getValue(),
                timeline.loopArea.from.getValue(), "->", timeline.loopArea.to.getValue())
        }
    }, 60000)
})
