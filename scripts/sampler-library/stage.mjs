#!/usr/bin/env node
// Downloads one VCSL folder and cuts the silence: the head 5 ms before the sample first reaches -60 dB of its own peak,
// with a 5 ms fade-in, the tail 100 ms after it falls below, with a 100 ms fade. Sample rate and channels stay, --bits 16
// converts to 16 bit with dither. Writes the files and a manifest into <out>/<slug>/.
import {mkdirSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {parseArgs} from "node:util"
import {readWav, sampleReader} from "./wav.mjs"

const {values} = parseArgs({options: {folder: {type: "string"}, slug: {type: "string"}, out: {type: "string"}, bits: {type: "string"}}})
if (!values.folder || !values.slug || !values.out || (values.bits !== undefined && values.bits !== "16")) {
    console.error("Usage: node scripts/sampler-library/stage.mjs --folder <VCSL folder> --slug <slug> --out <dir> [--bits 16]")
    process.exit(1)
}

const Repository = "sgossner/VCSL"
const Branch = "master"
const ThresholdDb = -60
const FadeSeconds = 0.1
const PreRollSeconds = 0.005

// 16 bit with TPDF dither, so quiet decays do not turn grainy
const toPcm16 = (source, count, valueAt) => {
    const target = new DataView(new ArrayBuffer(count * 2))
    for (let index = 0; index < count; index++) {
        const dithered = valueAt(index) * 32768 + Math.random() - Math.random()
        target.setInt16(index * 2, Math.max(-32768, Math.min(32767, Math.round(dithered))), true)
    }
    return new Uint8Array(target.buffer)
}

const cut = bytes => {
    const {format, data} = readWav(bytes)
    const {channels, sampleRate} = format
    const {bytes: width, read, write} = sampleReader(format)
    const frameBytes = width * channels
    const frames = Math.floor(data.length / frameBytes)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const level = frame => {
        let max = 0
        for (let channel = 0; channel < channels; channel++) {max = Math.max(max, Math.abs(read(view, frame * frameBytes + channel * width)))}
        return max
    }
    let peak = 0
    for (let frame = 0; frame < frames; frame++) {peak = Math.max(peak, level(frame))}
    const threshold = peak * 10 ** (ThresholdDb / 20)
    let first = -1
    let last = 0
    for (let frame = 0; frame < frames; frame++) {
        if (level(frame) < threshold) {continue}
        if (first < 0) {first = frame}
        last = frame
    }
    const preRoll = Math.round(PreRollSeconds * sampleRate)
    const start = Math.max(0, first - preRoll)
    const fade = Math.round(FadeSeconds * sampleRate)
    const end = Math.min(frames, last + 1 + fade)
    const length = end - start
    const out = new Uint8Array(length * frameBytes)
    out.set(data.subarray(start * frameBytes, end * frameBytes))
    const outView = new DataView(out.buffer)
    const scale = (frame, gain) => {
        for (let channel = 0; channel < channels; channel++) {
            const at = frame * frameBytes + channel * width
            write(outView, at, read(outView, at) * gain)
        }
    }
    if (start > 0) {for (let frame = 0; frame < preRoll; frame++) {scale(frame, frame / preRoll)}}
    for (let frame = Math.max(0, length - fade); frame < length; frame++) {scale(frame, (length - frame) / fade)}
    const data16 = values.bits === "16" && format.bits !== 16
    const payload = data16 ? toPcm16(out, length * channels, at => read(outView, at * width)) : out
    const bits = data16 ? 16 : format.bits
    const tag = data16 ? 1 : format.tag
    const blockAlign = channels * bits / 8
    const header = new DataView(new ArrayBuffer(44))
    const ascii = (at, text) => [...text].forEach((char, index) => header.setUint8(at + index, char.charCodeAt(0)))
    ascii(0, "RIFF")
    header.setUint32(4, 36 + payload.length, true)
    ascii(8, "WAVE")
    ascii(12, "fmt ")
    header.setUint32(16, 16, true)
    header.setUint16(20, tag, true)
    header.setUint16(22, channels, true)
    header.setUint32(24, sampleRate, true)
    header.setUint32(28, sampleRate * blockAlign, true)
    header.setUint16(32, blockAlign, true)
    header.setUint16(34, bits, true)
    ascii(36, "data")
    header.setUint32(40, payload.length, true)
    return {bytes: Buffer.concat([new Uint8Array(header.buffer), payload]), before: frames / sampleRate, after: length / sampleRate,
        head: start / sampleRate, peak: 20 * Math.log10(peak), format}
}

const tree = await (await fetch(`https://api.github.com/repos/${Repository}/git/trees/${Branch}?recursive=1`)).json()
const prefix = `${values.folder}/`
const paths = tree.tree.map(entry => entry.path)
    .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && path.toLowerCase().endsWith(".wav"))
    .sort()
if (paths.length === 0) {
    console.error(`No WAVs in ${values.folder}`)
    process.exit(1)
}
const directory = join(values.out, values.slug)
mkdirSync(directory, {recursive: true})
const files = []
for (const path of paths) {
    const url = `https://raw.githubusercontent.com/${Repository}/${Branch}/${path.split("/").map(encodeURIComponent).join("/")}`
    const response = await fetch(url)
    if (!response.ok) {throw new Error(`${response.status} ${url}`)}
    const file = path.split("/").at(-1)
    const result = cut(new Uint8Array(await response.arrayBuffer()))
    writeFileSync(join(directory, file), result.bytes)
    files.push({file, name: file.replace(/\.wav$/i, ""), before: result.before, after: result.after, peak: result.peak})
    console.log(`${file}  ${result.format.sampleRate} Hz ${result.format.bits} bit ${result.format.channels} ch  ${result.before.toFixed(1)}s -> ${result.after.toFixed(1)}s  head ${(result.head * 1000).toFixed(0)} ms  peak ${result.peak.toFixed(1)} dB`)
}
writeFileSync(join(directory, "manifest.json"), JSON.stringify({folder: values.folder, slug: values.slug, files}, null, 2) + "\n")
const sum = key => files.reduce((total, file) => total + file[key], 0)
console.log(`${files.length} files, ${sum("before").toFixed(1)}s -> ${sum("after").toFixed(1)}s, loudest peak ${Math.max(...files.map(file => file.peak)).toFixed(1)} dB`)
