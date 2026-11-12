import {beforeEach, describe, expect, it} from "vitest"
import {Option, Progress, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {OpfsProtocol, SamplePeakWorker} from "@opendaw/lib-fusion"
import {AudioData, PcmData, WavFile} from "@opendaw/lib-dsp"
import {SampleLoader, SampleMetaData} from "@opendaw/studio-adapters"
import {Workers} from "../Workers"
import {SampleStorage} from "./SampleStorage"
import {DefaultSampleLoader} from "./DefaultSampleLoader"
import {GlobalSampleLoaderManager} from "./GlobalSampleLoaderManager"
import {SampleProvider} from "./SampleProvider"

// The storage worker and the peak worker run in this process, the files live in a map.
const files = new Map<string, Uint8Array>()
const reads: Array<string> = []
const channel = new MessageChannel()
Workers.messenger = Option.wrap(Messenger.for(channel.port1))
const worker = Messenger.for(channel.port2)
SamplePeakWorker.install(worker)
Communicator.executor<OpfsProtocol>(worker.channel("opfs"), {
    write: async (path: string, data: Uint8Array): Promise<void> => {files.set(path, data.slice())},
    read: async (path: string): Promise<Uint8Array> => {
        reads.push(path)
        const bytes = files.get(path)
        return bytes === undefined ? Promise.reject(new Error(`not found: ${path}`)) : bytes.slice()
    },
    exists: async (path: string): Promise<boolean> => Array.from(files.keys()).some(key => key.startsWith(path)),
    delete: async (path: string): Promise<void> => {
        Array.from(files.keys()).filter(key => key.startsWith(path)).forEach(key => files.delete(key))
    },
    list: async (): Promise<ReadonlyArray<OpfsProtocol.Entry>> => [],
    isAvailable: async (): Promise<boolean> => true
})

const storage = SampleStorage.get()
const meta: SampleMetaData = {name: "test", bpm: 120, duration: 1, sample_rate: 48_000, origin: "import"}

const audioOf = (...channels: ReadonlyArray<ReadonlyArray<number>>): AudioData => {
    const audio = AudioData.create(48_000, channels[0].length, channels.length)
    channels.forEach((values, index) => audio.frames[index].set(values))
    return audio
}

// values a 16 bit file holds exactly, and values it does not
const exact = (): AudioData => audioOf([0.5, -0.25, 0, 32_767 / 32_768, -1], [0.125, 0.75, -0.5, 0, 1 / 32_768])
const inexact = (): AudioData => audioOf([0.1, -0.2, 0.3, 0.4, -0.5], [0.6, 0.7, -0.8, 0.9, 0.11])

const bitsOf = (audio: AudioData): Array<Array<number>> =>
    audio.frames.map(frames => Array.from(new Uint32Array(frames.buffer.slice(frames.byteOffset, frames.byteOffset + frames.byteLength))))

const peaksOf = (audio: AudioData): Promise<ArrayBuffer> => Workers.Peak.generateAsync(Progress.Empty, new Uint8Array([2]),
    audio.frames, audio.numberOfFrames, audio.numberOfChannels) as Promise<ArrayBuffer>

const put = async (audio: AudioData, format: SampleStorage.Format): Promise<UUID.Bytes> => {
    const uuid = UUID.generate()
    storage.format = format
    await storage.save({uuid, audio, peaks: await peaksOf(audio), meta})
    return uuid
}

const audioFile = (uuid: UUID.Bytes): Uint8Array => files.get(`${SampleStorage.Folder}/${UUID.toString(uuid)}/audio.wav`)!
const audioReads = (uuid: UUID.Bytes): number => reads.filter(path => path === `${SampleStorage.Folder}/${UUID.toString(uuid)}/audio.wav`).length
const headerOf = (uuid: UUID.Bytes): { tag: number, bits: number } => {
    const bytes = audioFile(uuid)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return {tag: view.getUint16(20, true), bits: view.getUint16(34, true)}
}

const providerOf = (samples: Map<string, AudioData>): SampleProvider & { calls: number } => {
    const provider = {
        calls: 0,
        fetch: async (uuid: UUID.Bytes): Promise<[AudioData, SampleMetaData]> => {
            provider.calls++
            const audio = samples.get(UUID.toString(uuid))
            return audio === undefined ? Promise.reject(new Error("Sample not found")) : [audio, meta]
        }
    }
    return provider
}

beforeEach(() => {
    files.clear()
    reads.length = 0
    storage.format = "float32"
})

describe("SampleStorage format", () => {
    it("writes float by default, also for frames 16 bit could hold", async () => {
        const uuid = await put(exact(), "float32")
        expect(headerOf(uuid)).toEqual({tag: 3, bits: 32})
        expect(audioFile(uuid).byteLength).toBe(44 + 5 * 2 * 4)
    })
    it("writes exactly what it wrote before for the default format", async () => {
        const audio = inexact()
        const uuid = await put(audio, "float32")
        expect(Array.from(audioFile(uuid))).toEqual(Array.from(new Uint8Array(WavFile.encodeFloats(audio))))
    })
    it("writes 16 bit for exact frames when set to smallest", async () => {
        const uuid = await put(exact(), "smallest")
        expect(headerOf(uuid)).toEqual({tag: 1, bits: 16})
        expect(audioFile(uuid).byteLength).toBe(44 + 5 * 2 * 2)
    })
    it("keeps float for inexact frames when set to smallest, byte for byte", async () => {
        const audio = inexact()
        const uuid = await put(audio, "smallest")
        expect(Array.from(audioFile(uuid))).toEqual(Array.from(new Uint8Array(WavFile.encodeFloats(audio))))
    })
    it("keeps float for frames holding negative zero", async () => {
        const uuid = await put(audioOf([0.5, -0]), "smallest")
        expect(headerOf(uuid)).toEqual({tag: 3, bits: 32})
    })
    it("loads a 16 bit file to the floats that were saved, bit for bit", async () => {
        const audio = exact()
        const uuid = await put(audio, "smallest")
        const [loaded, peaks, loadedMeta] = await storage.load(uuid)
        expect(bitsOf(loaded)).toEqual(bitsOf(audio))
        expect([loaded.sampleRate, loaded.numberOfFrames, loaded.numberOfChannels]).toEqual([48_000, 5, 2])
        expect(peaks.numFrames).toBe(5)
        expect(loadedMeta).toEqual(meta)
    })
    it("loads the same floats whichever format the sample was stored in", async () => {
        const audio = exact()
        const [asFloat] = await storage.load(await put(audio, "float32"))
        const [asSmallest] = await storage.load(await put(audio, "smallest"))
        expect(bitsOf(asSmallest)).toEqual(bitsOf(asFloat))
    })
    it("store answers with the frames as they were written", async () => {
        storage.format = "smallest"
        const audio = exact()
        const written = await storage.store({uuid: UUID.generate(), audio, peaks: await peaksOf(audio), meta})
        expect(written.format).toBe("int16")
        const kept = await storage.store({uuid: UUID.generate(), audio: inexact(), peaks: await peaksOf(audio), meta})
        expect(kept.format).toBe("float32")
    })
    it("loadPcm leaves 16 bit as 16 bit and reads the audio file only", async () => {
        const uuid = await put(exact(), "smallest")
        reads.length = 0
        const pcm = await storage.loadPcm(uuid)
        expect(pcm.format).toBe("int16")
        expect(pcm.format === "int16" && Array.from(pcm.frames[0])).toEqual([16_384, -8192, 0, 32_767, -32_768])
        expect(reads).toEqual([`${SampleStorage.Folder}/${UUID.toString(uuid)}/audio.wav`])
    })
    it("loadPcm gives floats for a float file", async () => {
        const audio = inexact()
        const pcm = await storage.loadPcm(await put(audio, "smallest"))
        expect(pcm.format).toBe("float32")
        expect(bitsOf(PcmData.floats(pcm))).toEqual(bitsOf(audio))
    })
    it("loadStored gives frames, peaks and meta", async () => {
        const [pcm, peaks, loadedMeta] = await storage.loadStored(await put(exact(), "smallest"))
        expect([pcm.format, pcm.numberOfFrames, pcm.numberOfChannels, pcm.sampleRate]).toEqual(["int16", 5, 2, 48_000])
        expect(peaks.numFrames).toBe(5)
        expect(loadedMeta).toEqual(meta)
    })
    it("loadStored rebuilds missing peaks from 16 bit frames", async () => {
        const uuid = await put(exact(), "smallest")
        files.set(`${SampleStorage.Folder}/${UUID.toString(uuid)}/peaks.bin`, new Uint8Array(0))
        const [, peaks] = await storage.loadStored(uuid)
        expect(peaks.numFrames).toBe(5)
        expect(files.get(`${SampleStorage.Folder}/${UUID.toString(uuid)}/peaks.bin`)!.byteLength).toBeGreaterThan(0)
    })
    it("rejects for a sample that is not stored", async () => {
        await expect(storage.loadPcm(UUID.generate())).rejects.toThrow()
        await expect(storage.loadStored(UUID.generate())).rejects.toThrow()
    })
})

describe("SampleStorage.replaceAudio", () => {
    const pathOf = (uuid: UUID.Bytes, file: string): string => `${SampleStorage.Folder}/${UUID.toString(uuid)}/${file}`
    it("turns a float file into 16 bit and leaves nothing behind", async () => {
        const audio = exact()
        const uuid = await put(audio, "float32")
        await storage.replaceAudio(uuid, PcmData.smallest(audio))
        expect(headerOf(uuid)).toEqual({tag: 1, bits: 16})
        expect(files.has(pathOf(uuid, SampleStorage.Pending))).toBe(false)
        expect(bitsOf((await storage.load(uuid))[0])).toEqual(bitsOf(audio))
    })
    it("leaves peaks and meta alone", async () => {
        const audio = exact()
        const uuid = await put(audio, "float32")
        const before = [files.get(pathOf(uuid, "peaks.bin")), files.get(pathOf(uuid, "meta.json"))]
        await storage.replaceAudio(uuid, PcmData.smallest(audio))
        expect([files.get(pathOf(uuid, "peaks.bin")), files.get(pathOf(uuid, "meta.json"))]).toEqual(before)
    })
    it("a load completes a replacement that was cut off", async () => {
        const audio = exact()
        const uuid = await put(audio, "float32")
        files.set(pathOf(uuid, SampleStorage.Pending), new Uint8Array(WavFile.encodePcm(PcmData.smallest(audio))))
        files.set(pathOf(uuid, "audio.wav"), audioFile(uuid).slice(0, 51))
        const [loaded] = await storage.load(uuid)
        expect(bitsOf(loaded)).toEqual(bitsOf(audio))
        expect(headerOf(uuid)).toEqual({tag: 1, bits: 16})
        expect(files.has(pathOf(uuid, SampleStorage.Pending))).toBe(false)
    })
    it("loadPcm and loadStored complete it as well", async () => {
        const audio = exact()
        for (const read of [(uuid: UUID.Bytes) => storage.loadPcm(uuid), (uuid: UUID.Bytes) => storage.loadStored(uuid).then(([pcm]) => pcm)]) {
            const uuid = await put(audio, "float32")
            files.set(pathOf(uuid, SampleStorage.Pending), new Uint8Array(WavFile.encodePcm(PcmData.smallest(audio))))
            files.set(pathOf(uuid, "audio.wav"), new Uint8Array(0))
            expect((await read(uuid)).format).toBe("int16")
            expect(files.has(pathOf(uuid, SampleStorage.Pending))).toBe(false)
        }
    })
    it("an intact file wins over what was left behind", async () => {
        const audio = inexact()
        const uuid = await put(audio, "float32")
        files.set(pathOf(uuid, SampleStorage.Pending), new Uint8Array([1, 2, 3]))
        expect(bitsOf((await storage.load(uuid))[0])).toEqual(bitsOf(audio))
        await storage.settle(uuid)
        expect(files.has(pathOf(uuid, SampleStorage.Pending))).toBe(false)
        expect(headerOf(uuid)).toEqual({tag: 3, bits: 32})
    })
    it("a broken file with nothing left behind still fails", async () => {
        const uuid = await put(exact(), "float32")
        files.set(pathOf(uuid, "audio.wav"), new Uint8Array(10))
        await expect(storage.load(uuid)).rejects.toThrow()
    })
    it("a broken file with a broken copy fails and keeps both", async () => {
        const uuid = await put(exact(), "float32")
        files.set(pathOf(uuid, "audio.wav"), new Uint8Array(10))
        files.set(pathOf(uuid, SampleStorage.Pending), new Uint8Array(7))
        await expect(storage.loadPcm(uuid)).rejects.toThrow()
        expect(files.has(pathOf(uuid, SampleStorage.Pending))).toBe(true)
    })
    it("settle does nothing for an ordinary sample", async () => {
        const uuid = await put(exact(), "smallest")
        const before = new Map(files)
        await storage.settle(uuid)
        expect(Array.from(files.keys())).toEqual(Array.from(before.keys()))
    })
})

describe("SampleStorage.convert", () => {
    it("rewrites an exact float sample as 16 bit without changing a value", async () => {
        const audio = exact()
        const uuid = await put(audio, "float32")
        expect(await storage.convert(uuid, "exact")).toBe(true)
        expect(headerOf(uuid)).toEqual({tag: 1, bits: 16})
        expect(bitsOf((await storage.load(uuid))[0])).toEqual(bitsOf(audio))
    })
    it("rounds an inexact sample when asked to", async () => {
        const audio = inexact()
        const uuid = await put(audio, "float32")
        expect(await storage.convert(uuid, "rounding")).toBe(true)
        expect(headerOf(uuid)).toEqual({tag: 1, bits: 16})
        const [loaded] = await storage.load(uuid)
        loaded.frames.forEach((frames, channel) => frames.forEach((value, frame) =>
            expect(Math.abs(value - audio.frames[channel][frame])).toBeLessThanOrEqual(0.5 / 32_768)))
    })
    it("lowers a sample just above full scale to full scale", async () => {
        const uuid = await put(audioOf([1.01, -0.5, 0.25]), "float32")
        expect(await storage.convert(uuid, "scaling")).toBe(true)
        const [loaded] = await storage.load(uuid)
        expect(loaded.frames[0][0]).toBe(32_767 / 32_768)
        expect(Math.max(...Array.from(loaded.frames[0]).map(Math.abs))).toBeLessThan(1.0)
    })
    it("does not touch a sample that is not of the expected kind", async () => {
        const uuid = await put(inexact(), "float32")
        const before = audioFile(uuid).slice()
        expect(await storage.convert(uuid, "exact")).toBe(false)
        expect(await storage.convert(uuid, "scaling")).toBe(false)
        expect(Array.from(audioFile(uuid))).toEqual(Array.from(before))
    })
    it("does not touch a sample that is too loud or already 16 bit", async () => {
        const loud = await put(audioOf([2.0, 0.1]), "float32")
        expect(await storage.convert(loud, "float")).toBe(false)
        expect(headerOf(loud)).toEqual({tag: 3, bits: 32})
        const small = await put(exact(), "smallest")
        expect(await storage.convert(small, "sixteen")).toBe(false)
        expect(await storage.convert(small, "exact")).toBe(false)
    })
    it("a converted sample loads in a loader as 16 bit with the same floats", async () => {
        const audio = exact()
        const uuid = await put(audio, "float32")
        const manager = new GlobalSampleLoaderManager(providerOf(new Map()), {retain: "while-used"})
        const loader = manager.getOrCreate(uuid)
        expect((await SampleLoader.stored(loader)).format).toBe("float32")
        await storage.convert(uuid, "exact")
        manager.invalidate(uuid)
        expect((await SampleLoader.stored(loader)).format).toBe("int16")
        expect(bitsOf(await manager.getAudioData(uuid))).toEqual(bitsOf(audio))
    })
    it("rejects for a sample that is not stored", async () => {
        await expect(storage.convert(UUID.generate(), "exact")).rejects.toThrow()
    })
})

describe("DefaultSampleLoader, retention always", () => {
    const loaded = async (audio: AudioData): Promise<DefaultSampleLoader> => {
        const loader = new DefaultSampleLoader(UUID.generate())
        const [, peaks] = await storage.load(await put(audio, "float32"))
        loader.setLoaded(audio, peaks, meta)
        return loader
    }
    it("is the default", () => expect(new DefaultSampleLoader(UUID.generate()).retention).toBe("always"))
    it("keeps the frames once loaded", async () => {
        const audio = inexact()
        const loader = await loaded(audio)
        expect(loader.data.unwrap()).toBe(audio)
        expect(loader.info.unwrap()).toEqual({sampleRate: 48_000, numberOfFrames: 5, numberOfChannels: 2})
        expect(loader.state.type).toBe("loaded")
    })
    it("hands out the very frames it holds and keeps them after the lease", async () => {
        const audio = inexact()
        const loader = await loaded(audio)
        const lease = await loader.acquire()
        expect(lease.data).toBe(audio)
        expect(loader.leases).toBe(1)
        lease.terminate()
        expect(loader.leases).toBe(0)
        expect(loader.data.unwrap()).toBe(audio)
    })
    it("never reads storage for a lease", async () => {
        const loader = await loaded(inexact())
        reads.length = 0
        const lease = await loader.acquire()
        lease.terminate()
        expect(reads).toEqual([])
    })
    it("gives the engine the float frames themselves when storage writes float", async () => {
        const audio = exact()
        const loader = await loaded(audio)
        const pcm = await loader.pcm()
        expect(pcm.format).toBe("float32")
        expect(pcm.frames[0]).toBe(audio.frames[0])
    })
    it("gives the engine 16 bit for exact frames when storage writes smallest", async () => {
        const loader = await loaded(exact())
        storage.format = "smallest"
        reads.length = 0
        const pcm = await loader.pcm()
        expect(pcm.format).toBe("int16")
        expect(reads).toEqual([])
        expect(await loader.pcm()).toBe(pcm)
    })
    it("gives the engine floats for inexact frames when storage writes smallest", async () => {
        const audio = inexact()
        const loader = await loaded(audio)
        storage.format = "smallest"
        const pcm = await loader.pcm()
        expect(pcm.format).toBe("float32")
        expect(pcm.frames[0]).toBe(audio.frames[0])
    })
    it("forgets everything when invalidated", async () => {
        const loader = await loaded(inexact())
        loader.invalidate()
        expect([loader.data.isEmpty(), loader.info.isEmpty(), loader.peaks.isEmpty(), loader.meta.isEmpty()]).toEqual([true, true, true, true])
        expect(loader.state.type).toBe("progress")
    })
})

describe("DefaultSampleLoader, retention while-used", () => {
    const stored = async (audio: AudioData, format: SampleStorage.Format = "smallest"): Promise<DefaultSampleLoader> => {
        const uuid = await put(audio, format)
        const loader = new DefaultSampleLoader(uuid, "while-used")
        const [pcm, peaks] = await storage.loadStored(uuid)
        const {sampleRate, numberOfFrames, numberOfChannels} = pcm
        loader.setStored({sampleRate, numberOfFrames, numberOfChannels}, peaks, meta, Option.None)
        reads.length = 0
        return loader
    }
    it("is loaded without frames, with info, peaks and meta", async () => {
        const loader = await stored(exact())
        expect(loader.state.type).toBe("loaded")
        expect(loader.data.isEmpty()).toBe(true)
        expect(loader.info.unwrap()).toEqual({sampleRate: 48_000, numberOfFrames: 5, numberOfChannels: 2})
        expect(loader.peaks.nonEmpty()).toBe(true)
        expect(loader.meta.unwrap()).toEqual(meta)
    })
    it("reads the frames for a lease and lets go when it ends", async () => {
        const audio = exact()
        const loader = await stored(audio)
        const lease = await loader.acquire()
        expect(bitsOf(lease.data)).toEqual(bitsOf(audio))
        expect(loader.data.unwrap()).toBe(lease.data)
        expect(audioReads(loader.uuid)).toBe(1)
        lease.terminate()
        expect(loader.data.isEmpty()).toBe(true)
        expect(loader.leases).toBe(0)
    })
    it("shares one copy between leases and keeps it until the last one ends", async () => {
        const loader = await stored(exact())
        const [first, second] = await Promise.all([loader.acquire(), loader.acquire()])
        expect(second.data).toBe(first.data)
        expect(loader.leases).toBe(2)
        first.terminate()
        expect(loader.data.nonEmpty()).toBe(true)
        second.terminate()
        expect(loader.data.isEmpty()).toBe(true)
    })
    it("reads the file once for leases taken at the same moment", async () => {
        const loader = await stored(exact())
        const [leases] = await Promise.all([Promise.all([loader.acquire(), loader.acquire(), loader.acquire()]), loader.pcm()])
        expect(audioReads(loader.uuid)).toBe(1)
        leases.forEach(lease => lease.terminate())
        expect(loader.leases).toBe(0)
    })
    it("ending a lease twice counts once", async () => {
        const loader = await stored(exact())
        const [first, second] = await Promise.all([loader.acquire(), loader.acquire()])
        first.terminate()
        first.terminate()
        expect(loader.leases).toBe(1)
        expect(loader.data.nonEmpty()).toBe(true)
        second.terminate()
    })
    it("finds frames that are still referenced without reading storage again", async () => {
        const loader = await stored(exact())
        const first = await loader.acquire()
        first.terminate()
        const second = await loader.acquire()
        expect(second.data).toBe(first.data)
        expect(audioReads(loader.uuid)).toBe(1)
        second.terminate()
    })
    it("gives float frames for a float file", async () => {
        const audio = inexact()
        const loader = await stored(audio)
        const lease = await loader.acquire()
        expect(bitsOf(lease.data)).toEqual(bitsOf(audio))
        lease.terminate()
    })
    it("rejects and counts no lease when the file is gone", async () => {
        const loader = await stored(exact())
        files.clear()
        await expect(loader.acquire()).rejects.toThrow()
        expect(loader.leases).toBe(0)
        expect(loader.data.isEmpty()).toBe(true)
    })
    it("gives the engine the stored 16 bit frames without inflating them", async () => {
        const loader = await stored(exact())
        const pcm = await loader.pcm()
        expect(pcm.format).toBe("int16")
        expect(loader.data.isEmpty()).toBe(true)
        expect(audioReads(loader.uuid)).toBe(1)
    })
    it("answers the engine and a lease from one read", async () => {
        const loader = await stored(exact())
        const pcm = await loader.pcm()
        const lease = await loader.acquire()
        expect(audioReads(loader.uuid)).toBe(1)
        expect(bitsOf(lease.data)).toEqual(bitsOf(PcmData.floats(pcm)))
        lease.terminate()
    })
    it("uses frames handed over at load without reading", async () => {
        const uuid = await put(exact(), "smallest")
        const [pcm, peaks] = await storage.loadStored(uuid)
        const loader = new DefaultSampleLoader(uuid, "while-used")
        const {sampleRate, numberOfFrames, numberOfChannels} = pcm
        loader.setStored({sampleRate, numberOfFrames, numberOfChannels}, peaks, meta, Option.wrap(pcm))
        reads.length = 0
        expect(await loader.pcm()).toBe(pcm)
        expect(reads).toEqual([])
        expect(loader.data.isEmpty()).toBe(true)
    })
    it("setLoaded lets the frames go unless a lease is open", async () => {
        const audio = exact()
        const uuid = await put(audio, "smallest")
        const [, peaks] = await storage.load(uuid)
        const loader = new DefaultSampleLoader(uuid, "while-used")
        loader.setLoaded(audio, peaks, meta)
        expect(loader.data.isEmpty()).toBe(true)
        expect(loader.info.unwrap().numberOfFrames).toBe(5)
    })
    it("waits for a sample that is still loading", async () => {
        const audio = exact()
        const uuid = await put(audio, "smallest")
        const [pcm, peaks] = await storage.loadStored(uuid)
        const loader = new DefaultSampleLoader(uuid, "while-used")
        const pending = loader.acquire()
        const {sampleRate, numberOfFrames, numberOfChannels} = pcm
        loader.setStored({sampleRate, numberOfFrames, numberOfChannels}, peaks, meta, Option.None)
        const lease = await pending
        expect(bitsOf(lease.data)).toEqual(bitsOf(audio))
        lease.terminate()
    })
    it("rejects a lease on a sample that failed to load", async () => {
        const loader = new DefaultSampleLoader(UUID.generate(), "while-used")
        const pending = loader.acquire()
        loader.setError("gone")
        await expect(pending).rejects.toThrow("gone")
        await expect(loader.acquire()).rejects.toThrow("gone")
        await expect(loader.pcm()).rejects.toThrow("gone")
        expect(loader.leases).toBe(0)
    })
})

describe("SampleLoader helpers", () => {
    const stored = async (): Promise<DefaultSampleLoader> => {
        const uuid = await put(exact(), "smallest")
        const loader = new DefaultSampleLoader(uuid, "while-used")
        const [pcm, peaks] = await storage.loadStored(uuid)
        const {sampleRate, numberOfFrames, numberOfChannels} = pcm
        loader.setStored({sampleRate, numberOfFrames, numberOfChannels}, peaks, meta, Option.None)
        return loader
    }
    it("use leases for the run and ends the lease", async () => {
        const loader = await stored()
        const frames = await SampleLoader.use(loader, audio => {
            expect(loader.leases).toBe(1)
            return audio.numberOfFrames
        })
        expect(frames).toBe(5)
        expect(loader.leases).toBe(0)
        expect(loader.data.isEmpty()).toBe(true)
    })
    it("use waits for an asynchronous user", async () => {
        const loader = await stored()
        const result = SampleLoader.use(loader, async audio => {
            await Promise.resolve()
            expect(loader.data.nonEmpty()).toBe(true)
            return audio.sampleRate
        })
        expect(await result).toBe(48_000)
        expect(loader.leases).toBe(0)
    })
    it("use ends the lease when the user throws", async () => {
        const loader = await stored()
        await expect(SampleLoader.use(loader, () => {throw new Error("boom")})).rejects.toThrow("boom")
        expect(loader.leases).toBe(0)
        expect(loader.data.isEmpty()).toBe(true)
    })
    it("use ends the lease when the user rejects", async () => {
        const loader = await stored()
        await expect(SampleLoader.use(loader, () => Promise.reject(new Error("later")))).rejects.toThrow("later")
        expect(loader.leases).toBe(0)
    })
    it("frames hands the data to the caller and leaves no lease", async () => {
        const loader = await stored()
        const audio = await SampleLoader.frames(loader)
        expect(audio.numberOfFrames).toBe(5)
        expect(loader.leases).toBe(0)
    })
    it("loaded resolves at once for a loaded sample and rejects for a failed one", async () => {
        await expect(SampleLoader.loaded(await stored())).resolves.toBeUndefined()
        const failed = new DefaultSampleLoader(UUID.generate())
        failed.setError("nope")
        await expect(SampleLoader.loaded(failed)).rejects.toThrow("nope")
    })
    it("stored falls back to the floats of a loader that has no pcm", async () => {
        const audio = inexact()
        const lease = {data: audio, terminate: () => {}}
        const plain: SampleLoader = {
            data: Option.wrap(audio), info: Option.None, peaks: Option.None, meta: Option.None, uuid: UUID.generate(),
            state: {type: "loaded"}, invalidate: () => {}, acquire: async () => lease,
            subscribe: observer => {
                observer({type: "loaded"})
                return {terminate: () => {}}
            }
        }
        const pcm = await SampleLoader.stored(plain)
        expect(pcm.format).toBe("float32")
        expect(pcm.frames[0]).toBe(audio.frames[0])
    })
    it("infoOf answers with the data of a loader written before info existed", () => {
        const audio = inexact()
        const legacy = {data: Option.wrap(audio)} as unknown as SampleLoader
        expect(SampleLoader.infoOf(legacy).unwrap().numberOfFrames).toBe(5)
    })
})

describe("GlobalSampleLoaderManager", () => {
    it("keeps frames by default, as it always did", async () => {
        const audio = exact()
        const uuid = await put(audio, "float32")
        const manager = new GlobalSampleLoaderManager(providerOf(new Map()))
        expect(manager.retain).toBe("always")
        const loader = manager.getOrCreate(uuid)
        await SampleLoader.loaded(loader)
        expect(bitsOf(loader.data.unwrap())).toEqual(bitsOf(audio))
        expect(loader.info.unwrap().numberOfChannels).toBe(2)
    })
    it("loads without frames when they are kept while used", async () => {
        const audio = exact()
        const uuid = await put(audio, "smallest")
        const manager = new GlobalSampleLoaderManager(providerOf(new Map()), {retain: "while-used"})
        const loader = manager.getOrCreate(uuid)
        await SampleLoader.loaded(loader)
        expect(loader.data.isEmpty()).toBe(true)
        expect(loader.info.unwrap()).toEqual({sampleRate: 48_000, numberOfFrames: 5, numberOfChannels: 2})
        expect(loader.peaks.nonEmpty()).toBe(true)
        expect(bitsOf(await manager.getAudioData(uuid))).toEqual(bitsOf(audio))
        expect(loader.data.isEmpty()).toBe(true)
    })
    it("reads the audio file once for the load and the engine's first fetch", async () => {
        const uuid = await put(exact(), "smallest")
        reads.length = 0
        const manager = new GlobalSampleLoaderManager(providerOf(new Map()), {retain: "while-used"})
        const pcm = await SampleLoader.stored(manager.getOrCreate(uuid))
        expect(pcm.format).toBe("int16")
        expect(audioReads(uuid)).toBe(1)
    })
    it("getAudioData gives the same floats under both retentions", async () => {
        const audio = exact()
        const uuid = await put(audio, "smallest")
        const always = await new GlobalSampleLoaderManager(providerOf(new Map())).getAudioData(uuid)
        const whileUsed = await new GlobalSampleLoaderManager(providerOf(new Map()), {retain: "while-used"}).getAudioData(uuid)
        expect(bitsOf(whileUsed)).toEqual(bitsOf(always))
        expect(bitsOf(always)).toEqual(bitsOf(audio))
    })
    it("asks the provider for a sample that is not stored, stores it and never asks again", async () => {
        const uuid = UUID.generate()
        const audio = exact()
        const provider = providerOf(new Map([[UUID.toString(uuid), audio]]))
        storage.format = "smallest"
        const manager = new GlobalSampleLoaderManager(provider, {retain: "while-used"})
        const loader = manager.getOrCreate(uuid)
        await SampleLoader.loaded(loader)
        expect(provider.calls).toBe(1)
        expect(headerOf(uuid)).toEqual({tag: 1, bits: 16})
        expect(loader.data.isEmpty()).toBe(true)
        expect((await SampleLoader.stored(loader)).format).toBe("int16")
        expect(bitsOf(await manager.getAudioData(uuid))).toEqual(bitsOf(audio))
        const second = new GlobalSampleLoaderManager(provider, {retain: "while-used"})
        await SampleLoader.loaded(second.getOrCreate(uuid))
        expect(provider.calls).toBe(1)
    })
    it("keeps the provider's frames under the default retention", async () => {
        const uuid = UUID.generate()
        const audio = inexact()
        const manager = new GlobalSampleLoaderManager(providerOf(new Map([[UUID.toString(uuid), audio]])))
        const loader = manager.getOrCreate(uuid)
        await SampleLoader.loaded(loader)
        expect(loader.data.unwrap()).toBe(audio)
        expect(headerOf(uuid)).toEqual({tag: 3, bits: 32})
    })
    it("reports a sample neither stored nor provided as failed", async () => {
        const manager = new GlobalSampleLoaderManager(providerOf(new Map()), {retain: "while-used"})
        const loader = manager.getOrCreate(UUID.generate())
        await expect(SampleLoader.loaded(loader)).rejects.toThrow("Sample not found")
        await expect(loader.acquire()).rejects.toThrow()
        expect(loader.state.type).toBe("error")
    })
    it("gives a second loader of the same sample its info without frames", async () => {
        const uuid = await put(exact(), "smallest")
        const manager = new GlobalSampleLoaderManager(providerOf(new Map()), {retain: "while-used"})
        const keep = manager.register(uuid)
        const holdTwice = manager.register(uuid)
        await SampleLoader.loaded(manager.getOrCreate(uuid))
        holdTwice.terminate()
        const again = manager.getOrCreate(uuid)
        await SampleLoader.loaded(again)
        expect(again.data.isEmpty()).toBe(true)
        expect(again.info.unwrap().numberOfFrames).toBe(5)
        keep.terminate()
    })
    it("loads again after an invalidate and serves the new frames", async () => {
        const uuid = await put(exact(), "smallest")
        const manager = new GlobalSampleLoaderManager(providerOf(new Map()), {retain: "while-used"})
        const loader = manager.getOrCreate(uuid)
        await SampleLoader.loaded(loader)
        const replaced = audioOf([0.25, 0.25, 0.25], [0.5, 0.5, 0.5])
        storage.format = "smallest"
        await storage.save({uuid, audio: replaced, peaks: await peaksOf(replaced), meta})
        manager.invalidate(uuid)
        await SampleLoader.loaded(loader)
        expect(loader.info.unwrap().numberOfFrames).toBe(3)
        expect(bitsOf(await manager.getAudioData(uuid))).toEqual(bitsOf(replaced))
    })
    it("a lease taken before an invalidate keeps its frames", async () => {
        const audio = exact()
        const uuid = await put(audio, "smallest")
        const manager = new GlobalSampleLoaderManager(providerOf(new Map()), {retain: "while-used"})
        const loader = manager.getOrCreate(uuid)
        const lease = await loader.acquire()
        manager.invalidate(uuid)
        expect(bitsOf(lease.data)).toEqual(bitsOf(audio))
        lease.terminate()
        await SampleLoader.loaded(loader)
        expect(loader.data.isEmpty()).toBe(true)
    })
})
