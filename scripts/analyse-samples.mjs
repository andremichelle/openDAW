#!/usr/bin/env node
import {readFileSync, readdirSync, statSync} from "node:fs"
import {extname, join, relative, resolve} from "node:path"

function parseArgs(argv) {
    const args = {}
    for (let i = 2; i < argv.length; i++) {
        const token = argv[i]
        if (token.startsWith("--")) {
            const key = token.slice(2)
            const next = argv[i + 1]
            if (!next || next.startsWith("--")) {
                args[key] = true
            } else {
                args[key] = next
                i++
            }
        }
    }
    return args
}

function readWavInfo(buffer) {
    if (buffer.length < 44) throw new Error("Not a WAV file (too small)")
    if (buffer.toString("ascii", 0, 4) !== "RIFF") throw new Error("Not a RIFF file")
    if (buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAVE file")
    let offset = 12
    let sampleRate = 0
    let byteRate = 0
    let channels = 0
    let bitsPerSample = 0
    let dataSize = 0
    let format = 0
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString("ascii", offset, offset + 4)
        const size = buffer.readUInt32LE(offset + 4)
        const body = offset + 8
        if (id === "fmt ") {
            format = buffer.readUInt16LE(body + 0)
            channels = buffer.readUInt16LE(body + 2)
            sampleRate = buffer.readUInt32LE(body + 4)
            byteRate = buffer.readUInt32LE(body + 8)
            bitsPerSample = buffer.readUInt16LE(body + 14)
        } else if (id === "data") {
            dataSize = size
            break
        }
        offset = body + size + (size % 2)
    }
    if (!sampleRate || !byteRate || !channels || !bitsPerSample || !dataSize) {
        throw new Error("Missing fmt or data chunk")
    }
    return {sampleRate, channels, bitsPerSample, format, dataSize, duration: dataSize / byteRate}
}

function walkWavs(dir) {
    const out = []
    for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".")) continue
        const full = join(dir, entry)
        const st = statSync(full)
        if (st.isDirectory()) out.push(...walkWavs(full))
        else if (st.isFile() && extname(entry).toLowerCase() === ".wav") out.push({path: full, size: st.size})
    }
    return out
}

const args = parseArgs(process.argv)
const dir = args.dir
if (!dir) {
    console.error("Usage: node scripts/analyse-samples.mjs --dir <path> [--verbose]")
    process.exit(1)
}
const dirAbs = resolve(dir)
if (!statSync(dirAbs).isDirectory()) {
    console.error(`Not a directory: ${dirAbs}`)
    process.exit(1)
}

const files = walkWavs(dirAbs).sort((a, b) => a.path.localeCompare(b.path))
console.log(`Scanning ${files.length} .wav files under ${dirAbs}\n`)

const verbose = Boolean(args.verbose)
const longFiles = []
const highRateFiles = []
const nonStandardFormat = []
const errors = []
let totalBytes = 0
let totalDuration = 0
const byMachine = new Map()
const sampleRates = new Map()
const bitDepths = new Map()
const channelCounts = new Map()

for (const {path, size} of files) {
    totalBytes += size
    const rel = relative(dirAbs, path)
    const machine = rel.split("/")[0]
    byMachine.set(machine, (byMachine.get(machine) ?? 0) + 1)
    let info
    try {
        info = readWavInfo(readFileSync(path))
    } catch (error) {
        errors.push({path: rel, error: error.message})
        continue
    }
    totalDuration += info.duration
    sampleRates.set(info.sampleRate, (sampleRates.get(info.sampleRate) ?? 0) + 1)
    bitDepths.set(info.bitsPerSample, (bitDepths.get(info.bitsPerSample) ?? 0) + 1)
    channelCounts.set(info.channels, (channelCounts.get(info.channels) ?? 0) + 1)
    if (info.format !== 1 && info.format !== 3) {
        nonStandardFormat.push({path: rel, format: info.format})
    }
    if (info.duration > 10.0) longFiles.push({path: rel, duration: info.duration, size})
    if (info.sampleRate > 48_000) highRateFiles.push({path: rel, sampleRate: info.sampleRate})
    if (verbose) {
        console.log(
            `  ${rel}  ${info.sampleRate}Hz ${info.channels}ch ${info.bitsPerSample}-bit  ` +
            `${info.duration.toFixed(3)}s  ${(size / 1024).toFixed(1)}kB  fmt=${info.format}`)
    }
}

console.log("=== Per-machine counts ===")
for (const [machine, count] of [...byMachine.entries()].sort()) {
    console.log(`  ${machine.padEnd(20)} ${count}`)
}

console.log("\n=== Sample-rate distribution ===")
for (const [rate, count] of [...sampleRates.entries()].sort((a, b) => a[0] - b[0])) {
    const tag = rate > 48_000 ? "  ← >48kHz" : ""
    console.log(`  ${rate}Hz`.padEnd(14) + ` ${count}${tag}`)
}

console.log("\n=== Bit-depth distribution ===")
for (const [bits, count] of [...bitDepths.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${bits}-bit`.padEnd(14) + ` ${count}`)
}

console.log("\n=== Channel distribution ===")
for (const [ch, count] of [...channelCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${ch}ch`.padEnd(14) + ` ${count}`)
}

console.log(`\n=== Files longer than 10.0s (${longFiles.length}) ===`)
for (const f of longFiles.sort((a, b) => b.duration - a.duration)) {
    console.log(`  ${f.duration.toFixed(3)}s  ${(f.size / 1024).toFixed(1)}kB  ${f.path}`)
}

console.log(`\n=== Files above 48kHz (${highRateFiles.length}) ===`)
for (const f of highRateFiles) {
    console.log(`  ${f.sampleRate}Hz  ${f.path}`)
}

if (nonStandardFormat.length > 0) {
    console.log(`\n=== Non-PCM/IEEE format codes (${nonStandardFormat.length}) ===`)
    for (const f of nonStandardFormat) {
        console.log(`  fmt=${f.format}  ${f.path}`)
    }
}

if (errors.length > 0) {
    console.log(`\n=== Read errors (${errors.length}) ===`)
    for (const f of errors) {
        console.log(`  ${f.path}: ${f.error}`)
    }
}

console.log(
    `\n=== Totals ===` +
    `\n  files:    ${files.length}` +
    `\n  duration: ${totalDuration.toFixed(2)}s (${(totalDuration / 60).toFixed(2)} min)` +
    `\n  size:     ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
