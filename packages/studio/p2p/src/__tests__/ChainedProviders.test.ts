import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {SampleMetaData, SoundfontMetaData} from "@opendaw/studio-adapters"
import {ChainedSampleProvider, type SampleProvider} from "../ChainedSampleProvider"
import {ChainedSoundfontProvider, type SoundfontProvider} from "../ChainedSoundfontProvider"

const testUuid = UUID.generate()
const noopProgress = () => {}

const createCloudSampleProvider = (result: [AudioData, SampleMetaData]): SampleProvider => ({
    fetch: async () => result
})

const createFailingCloudSampleProvider = (error: Error): SampleProvider => ({
    fetch: async () => {throw error}
})

const createPeerSampleProvider = (result: [AudioData, SampleMetaData]): SampleProvider => ({
    fetch: async () => result
})

const testAudioData = AudioData.create(44100, 64, 1)
const testSampleMeta: SampleMetaData = {name: "test.wav", bpm: 120, duration: 1, sample_rate: 44100, origin: "import"}
const testSoundfontMeta: SoundfontMetaData = {name: "test.sf2", size: 1024, url: "", license: "CC0", origin: "import"}

describe("ChainedSampleProvider", () => {
    it("returns cloud result when cloud succeeds", async () => {
        const cloudResult: [AudioData, SampleMetaData] = [testAudioData, testSampleMeta]
        const chained = new ChainedSampleProvider(createCloudSampleProvider(cloudResult))
        const result = await chained.fetch(testUuid, noopProgress)
        expect(result).toBe(cloudResult)
    })
    it("throws when cloud fails and no peer attached", async () => {
        const chained = new ChainedSampleProvider(createFailingCloudSampleProvider(new Error("404")))
        await expect(chained.fetch(testUuid, noopProgress)).rejects.toThrow("404")
    })
    it("falls back to peer when cloud fails and peer attached", async () => {
        const peerResult: [AudioData, SampleMetaData] = [testAudioData, {...testSampleMeta, name: "from-peer.wav"}]
        const chained = new ChainedSampleProvider(createFailingCloudSampleProvider(new Error("404")))
        chained.attachPeer(createPeerSampleProvider(peerResult))
        const result = await chained.fetch(testUuid, noopProgress)
        expect(result).toBe(peerResult)
    })
    it("does not call peer when cloud succeeds", async () => {
        const cloudResult: [AudioData, SampleMetaData] = [testAudioData, testSampleMeta]
        const chained = new ChainedSampleProvider(createCloudSampleProvider(cloudResult))
        let peerCalled = false
        chained.attachPeer({fetch: async () => {peerCalled = true; return cloudResult}})
        await chained.fetch(testUuid, noopProgress)
        expect(peerCalled).toBe(false)
    })
    it("throws cloud error after detachPeer", async () => {
        const peerResult: [AudioData, SampleMetaData] = [testAudioData, testSampleMeta]
        const chained = new ChainedSampleProvider(createFailingCloudSampleProvider(new Error("404")))
        chained.attachPeer(createPeerSampleProvider(peerResult))
        chained.detachPeer()
        await expect(chained.fetch(testUuid, noopProgress)).rejects.toThrow("404")
    })
    it("passes progress handler to cloud provider", async () => {
        let receivedProgress: unknown = null
        const cloud: SampleProvider = {
            fetch: async (_uuid, progress) => {
                receivedProgress = progress
                return [testAudioData, testSampleMeta]
            }
        }
        const chained = new ChainedSampleProvider(cloud)
        const handler = () => {}
        await chained.fetch(testUuid, handler)
        expect(receivedProgress).toBe(handler)
    })
    it("passes progress handler to peer provider on fallback", async () => {
        let receivedProgress: unknown = null
        const peer: SampleProvider = {
            fetch: async (_uuid, progress) => {
                receivedProgress = progress
                return [testAudioData, testSampleMeta]
            }
        }
        const chained = new ChainedSampleProvider(createFailingCloudSampleProvider(new Error("404")))
        chained.attachPeer(peer)
        const handler = () => {}
        await chained.fetch(testUuid, handler)
        expect(receivedProgress).toBe(handler)
    })
})

describe("ChainedSoundfontProvider", () => {
    const testSf2 = new ArrayBuffer(512)

    const createCloudSoundfontProvider = (result: [ArrayBuffer, SoundfontMetaData]): SoundfontProvider => ({
        fetch: async () => result
    })
    const createFailingSoundfontProvider = (error: Error): SoundfontProvider => ({
        fetch: async () => {throw error}
    })
    it("returns cloud result when cloud succeeds", async () => {
        const cloudResult: [ArrayBuffer, SoundfontMetaData] = [testSf2, testSoundfontMeta]
        const chained = new ChainedSoundfontProvider(createCloudSoundfontProvider(cloudResult))
        const result = await chained.fetch(testUuid, noopProgress)
        expect(result).toBe(cloudResult)
    })
    it("throws when cloud fails and no peer attached", async () => {
        const chained = new ChainedSoundfontProvider(createFailingSoundfontProvider(new Error("404")))
        await expect(chained.fetch(testUuid, noopProgress)).rejects.toThrow("404")
    })
    it("falls back to peer when cloud fails and peer attached", async () => {
        const peerResult: [ArrayBuffer, SoundfontMetaData] = [testSf2, {...testSoundfontMeta, name: "from-peer.sf2"}]
        const chained = new ChainedSoundfontProvider(createFailingSoundfontProvider(new Error("404")))
        chained.attachPeer({fetch: async () => peerResult})
        const result = await chained.fetch(testUuid, noopProgress)
        expect(result).toBe(peerResult)
    })
    it("throws cloud error after detachPeer", async () => {
        const chained = new ChainedSoundfontProvider(createFailingSoundfontProvider(new Error("404")))
        chained.attachPeer({fetch: async () => [testSf2, testSoundfontMeta]})
        chained.detachPeer()
        await expect(chained.fetch(testUuid, noopProgress)).rejects.toThrow("404")
    })
})
