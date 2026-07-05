// TEMPORARY: where do the clap regions play, and what is the tempo?
import {describe, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {decodeAtstil} from "./helpers/atstil"

describe("atstil clap regions", () => {
    it("dumps clap track regions", async () => {
        const boxGraph = decodeAtstil()
        const short = (uuid: Uint8Array) => UUID.toString(uuid as UUID.Bytes).slice(0, 8)
        for (const box of boxGraph.boxes()) {
            if (box.name === "TimelineBox") {
                const timeline = box as unknown as {bpm: {getValue(): number}, durationInPulses: {getValue(): number}, loopArea: {from: {getValue(): number}, to: {getValue(): number}, enabled: {getValue(): boolean}}}
                console.log("TIMELINE bpm", timeline.bpm.getValue(), "loop", timeline.loopArea.enabled.getValue(), timeline.loopArea.from.getValue(), "->", timeline.loopArea.to.getValue())
            }
        }
        for (const box of boxGraph.boxes()) {
            if (box.name !== "TrackBox") {continue}
            const track = box as unknown as {target: {targetAddress: {unwrapOrNull(): {uuid: Uint8Array} | null}}, regions: {pointerHub: {incoming(): ReadonlyArray<{box: unknown}>}}}
            const addr = track.target.targetAddress.unwrapOrNull()
            if (addr === null) {continue}
            const owner = short(addr.uuid)
            if (owner !== "7c5abdd4" && owner !== "69c7890a") {continue}
            for (const incoming of track.regions.pointerHub.incoming()) {
                const region = incoming.box as {name: string, address: {uuid: Uint8Array}, position: {getValue(): number}, duration: {getValue(): number}}
                console.log("REGION on", owner, region.name, short(region.address.uuid), "position", region.position.getValue(), "duration", region.duration.getValue())
            }
        }
    }, 60000)
})
