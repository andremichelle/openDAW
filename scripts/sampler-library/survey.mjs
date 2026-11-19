#!/usr/bin/env node
// Measures the peak of every VCSL file (Legacy folders skipped) and writes one line per file into --out (JSON lines).
// A second run skips the files already in --out, so an interrupted survey resumes.
import {appendFileSync, existsSync, readFileSync} from "node:fs"
import {parseArgs} from "node:util"
import {readWav, sampleReader} from "./wav.mjs"

const {values} = parseArgs({options: {out: {type: "string"}, parallel: {type: "string", default: "6"}}})
if (!values.out) {
    console.error("Usage: node scripts/sampler-library/survey.mjs --out <file.jsonl> [--parallel 6]")
    process.exit(1)
}

const Repository = "sgossner/VCSL"
const Branch = "master"

const peakOf = bytes => {
    const {format, data} = readWav(bytes)
    const {bytes: width, read} = sampleReader(format)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const count = Math.floor(data.length / width)
    let peak = 0
    for (let index = 0; index < count; index++) {peak = Math.max(peak, Math.abs(read(view, index * width)))}
    return {peak: peak > 0 ? 20 * Math.log10(peak) : -Infinity, format, seconds: count / format.channels / format.sampleRate}
}

const done = new Set(existsSync(values.out)
    ? readFileSync(values.out, "utf8").split("\n").filter(line => line.length > 0).map(line => JSON.parse(line).path)
    : [])
const tree = await (await fetch(`https://api.github.com/repos/${Repository}/git/trees/${Branch}?recursive=1`)).json()
const paths = tree.tree.map(entry => entry.path)
    .filter(path => path.toLowerCase().endsWith(".wav") && !path.includes("Legacy") && !done.has(path))
console.log(`${paths.length} files to measure, ${done.size} done before`)
let next = 0
let measured = 0
const worker = async () => {
    while (next < paths.length) {
        const path = paths[next++]
        const url = `https://raw.githubusercontent.com/${Repository}/${Branch}/${path.split("/").map(encodeURIComponent).join("/")}`
        const line = {path, folder: path.split("/").slice(0, -1).join("/")}
        try {
            const response = await fetch(url)
            if (!response.ok) {throw new Error(`HTTP ${response.status}`)}
            const {peak, format, seconds} = peakOf(new Uint8Array(await response.arrayBuffer()))
            Object.assign(line, {peak, bits: format.bits, sampleRate: format.sampleRate, channels: format.channels, seconds})
        } catch (error) {
            line.error = String(error)
        }
        appendFileSync(values.out, JSON.stringify(line) + "\n")
        if (++measured % 100 === 0) {console.log(`${measured} / ${paths.length}`)}
    }
}
await Promise.all(Array.from({length: Number(values.parallel)}, worker))
console.log(`done, ${measured} measured`)
