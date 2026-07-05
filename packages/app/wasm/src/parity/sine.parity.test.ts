import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {nullTest, referenceSine, renderSineOffline} from "./harness"

// First parity test: the sine wasm vs the TS reference. Establishes the offline-render + null-test
// machinery; later tests feed real box-graph fixtures to both the Rust engine and the TS engine.
const WASM = path.resolve(__dirname, "../../public/wasm/sine.wasm")

describe("parity: sine (wasm vs TS reference)", () => {
    it("null-tests below tolerance over 64 blocks", async () => {
        const sampleRate = 48000
        const frequency = 440
        const frames = 128
        const blocks = 64
        const rendered = await renderSineOffline(WASM, sampleRate, frequency, frames, blocks)
        const reference = referenceSine(sampleRate, frequency, frames, blocks)
        const {peak, rms} = nullTest(rendered, reference)
        expect(peak).toBeLessThan(1e-5)
        expect(rms).toBeLessThan(1e-6)
    })
})
