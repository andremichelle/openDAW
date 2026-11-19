#!/usr/bin/env node
// Downloads one VCSL folder and cuts the tails: 100 ms after the sample falls below -60 dB of its own peak, with a
// 100 ms fade. Format and channels stay. Writes the files and a manifest into <out>/<slug>/.
import {mkdirSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {parseArgs} from "node:util"
import {readWav, sampleReader} from "./wav.mjs"

const {values} = parseArgs({options: {folder: {type: "string"}, slug: {type: "string"}, out: {type: "string"}}})
if (!values.folder || !values.slug || !values.out) {
    console.error("Usage: node scripts/sampler-library/stage.mjs --folder <VCSL folder> --slug <slug> --out <dir>")
    process.exit(1)
}

const Repository = "sgossner/VCSL"
const Branch = "master"
const ThresholdDb = -60
const FadeSeconds = 0.1

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
    let last = 0
    for (let frame = 0; frame < frames; frame++) {if (level(frame) >= threshold) {last = frame}}
    const fade = Math.round(FadeSeconds * sampleRate)
    const end = Math.min(frames, last + 1 + fade)
    const out = new Uint8Array(end * frameBytes)
    out.set(data.subarray(0, end * frameBytes))
    const outView = new DataView(out.buffer)
    for (let frame = Math.max(0, end - fade); frame < end; frame++) {
        const gain = (end - frame) / fade
        for (let channel = 0; channel < channels; channel++) {
            const at = frame * frameBytes + channel * width
            write(outView, at, read(outView, at) * gain)
        }
    }
    const header = new DataView(new ArrayBuffer(44))
    const ascii = (at, text) => [...text].forEach((char, index) => header.setUint8(at + index, char.charCodeAt(0)))
    ascii(0, "RIFF")
    header.setUint32(4, 36 + out.length, true)
    ascii(8, "WAVE")
    ascii(12, "fmt ")
    header.setUint32(16, 16, true)
    header.setUint16(20, format.tag, true)
    header.setUint16(22, channels, true)
    header.setUint32(24, sampleRate, true)
    header.setUint32(28, sampleRate * frameBytes, true)
    header.setUint16(32, frameBytes, true)
    header.setUint16(34, format.bits, true)
    ascii(36, "data")
    header.setUint32(40, out.length, true)
    return {bytes: Buffer.concat([new Uint8Array(header.buffer), out]), before: frames / sampleRate, after: end / sampleRate, peak: 20 * Math.log10(peak), format}
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
    console.log(`${file}  ${result.format.sampleRate} Hz ${result.format.bits} bit ${result.format.channels} ch  ${result.before.toFixed(1)}s -> ${result.after.toFixed(1)}s  peak ${result.peak.toFixed(1)} dB`)
}
writeFileSync(join(directory, "manifest.json"), JSON.stringify({folder: values.folder, slug: values.slug, files}, null, 2) + "\n")
const sum = key => files.reduce((total, file) => total + file[key], 0)
console.log(`${files.length} files, ${sum("before").toFixed(1)}s -> ${sum("after").toFixed(1)}s, loudest peak ${Math.max(...files.map(file => file.peak)).toFixed(1)} dB`)
