// The .odb bundle decoder: build a synthetic bundle (a real project + a sample) with JSZip, decode it, and verify
// the project box graph and the sample assets come back. This is the node-testable core of the Bundle Player; the
// OPFS SampleStorage write + engine playback are browser-only (verified by typecheck).
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioFileBox, RevampDeviceBox} from "@opendaw/studio-boxes"
import JSZip from "jszip"
import {decodeBundle} from "../src/bundle"

describe("bundle decode", () => {
    it("extracts the project box graph and the sample assets from an .odb", async () => {
        // Use a real project as the bundle's project.od, and synthesize a WAV for its AudioFileBox.
        const projectBytes = readFileSync(path.resolve(__dirname, "../public/projects/sunset.od"))
        const projectArray = projectBytes.buffer.slice(projectBytes.byteOffset, projectBytes.byteOffset + projectBytes.byteLength) as ArrayBuffer
        const {boxGraph} = ProjectSkeleton.decode(projectArray)
        const audioFile = boxGraph.boxes().find(box => box instanceof AudioFileBox) as AudioFileBox
        const sampleUuid = audioFile.address.uuid

        // A 0.1 s mono 48k ramp as the sample.
        const frames = [Float32Array.from({length: 4800}, (_v, i) => (i % 100) / 100 - 0.5)]
        const wav = WavFile.encodeFloats({frames, numberOfFrames: 4800, numberOfChannels: 1, sampleRate: 48000})

        const zip = new JSZip()
        zip.file("version", "1")
        zip.file("uuid", UUID.generate(), {binary: true})
        zip.file("project.od", projectArray, {binary: true})
        zip.file("meta.json", JSON.stringify({name: "sunset-bundle"}))
        zip.folder("samples")!.folder(UUID.toString(sampleUuid))!.file("audio.wav", wav, {binary: true})
        const odb = await zip.generateAsync({type: "arraybuffer"})

        const bundle = await decodeBundle(odb)
        expect(bundle.version).toBe("1")
        expect(bundle.uuid).not.toBeNull()
        // The project box graph decoded (it is the multi-Revamp sunset project).
        expect(bundle.boxGraph.boxes().some(box => box instanceof RevampDeviceBox)).toBe(true)
        // The one sample was extracted, keyed by the AudioFileBox uuid, and its bytes round-trip.
        expect(bundle.samples.length).toBe(1)
        expect(UUID.toString(bundle.samples[0].uuid)).toBe(UUID.toString(sampleUuid))
        const decoded = WavFile.decodeFloats(bundle.samples[0].wav)
        expect(decoded.numberOfFrames).toBe(4800)
        expect(decoded.frames[0][10]).toBeCloseTo(frames[0][10], 3)
    }, 30000)

    it("rejects an unknown bundle version", async () => {
        const zip = new JSZip()
        zip.file("version", "99")
        zip.file("project.od", new Uint8Array(0))
        const odb = await zip.generateAsync({type: "arraybuffer"})
        await expect(decodeBundle(odb)).rejects.toThrow(/version/)
    }, 30000)
})
