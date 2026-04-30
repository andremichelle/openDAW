#!/usr/bin/env node
import {mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from "node:fs"
import {dirname, extname, join, relative, resolve} from "node:path"

function parseArgs(argv) {
    const args = {}
    for (let i = 2; i < argv.length; i++) {
        const token = argv[i]
        if (token.startsWith("--")) {
            const key = token.slice(2)
            const next = argv[i + 1]
            if (!next || next.startsWith("--")) args[key] = true
            else { args[key] = next; i++ }
        }
    }
    return args
}

function readWav(buffer) {
    if (buffer.length < 44) throw new Error("Not a WAV file (too small)")
    if (buffer.toString("ascii", 0, 4) !== "RIFF") throw new Error("Not a RIFF file")
    if (buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAVE file")
    let offset = 12
    let format = 0
    let channels = 0
    let sampleRate = 0
    let bitsPerSample = 0
    let dataStart = -1
    let dataSize = 0
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString("ascii", offset, offset + 4)
        const size = buffer.readUInt32LE(offset + 4)
        const body = offset + 8
        if (id === "fmt ") {
            format = buffer.readUInt16LE(body + 0)
            channels = buffer.readUInt16LE(body + 2)
            sampleRate = buffer.readUInt32LE(body + 4)
            bitsPerSample = buffer.readUInt16LE(body + 14)
        } else if (id === "data") {
            dataStart = body
            dataSize = size
            break
        }
        offset = body + size + (size % 2)
    }
    if (dataStart < 0 || !sampleRate || !channels || !bitsPerSample) {
        throw new Error("Missing fmt or data chunk")
    }
    return {format, channels, sampleRate, bitsPerSample, dataStart, dataSize}
}

function convert24to16(srcBuffer, info) {
    const frames = info.dataSize / (info.channels * 3)
    if (!Number.isInteger(frames)) throw new Error("Data size not aligned to 24-bit frames")
    const totalSamples = frames * info.channels
    const out = Buffer.alloc(totalSamples * 2)
    let read = info.dataStart
    let write = 0
    for (let i = 0; i < totalSamples; i++) {
        const b0 = srcBuffer[read++]
        const b1 = srcBuffer[read++]
        const b2 = srcBuffer[read++]
        let s24 = b0 | (b1 << 8) | (b2 << 16)
        if (b2 & 0x80) s24 |= 0xff000000  // sign-extend to 32 bits
        const s16 = s24 >> 8  // arithmetic right shift, signed
        out.writeInt16LE(Math.max(-32768, Math.min(32767, s16)), write)
        write += 2
    }
    return out
}

function buildWav16(pcm16, channels, sampleRate) {
    const dataSize = pcm16.length
    const fmtSize = 16
    const totalSize = 4 + (8 + fmtSize) + (8 + dataSize)
    const out = Buffer.alloc(8 + totalSize)
    let p = 0
    out.write("RIFF", p, "ascii"); p += 4
    out.writeUInt32LE(totalSize, p); p += 4
    out.write("WAVE", p, "ascii"); p += 4
    out.write("fmt ", p, "ascii"); p += 4
    out.writeUInt32LE(fmtSize, p); p += 4
    out.writeUInt16LE(1, p); p += 2                    // PCM
    out.writeUInt16LE(channels, p); p += 2
    out.writeUInt32LE(sampleRate, p); p += 4
    out.writeUInt32LE(sampleRate * channels * 2, p); p += 4   // byte rate
    out.writeUInt16LE(channels * 2, p); p += 2          // block align
    out.writeUInt16LE(16, p); p += 2                    // bits per sample
    out.write("data", p, "ascii"); p += 4
    out.writeUInt32LE(dataSize, p); p += 4
    pcm16.copy(out, p)
    return out
}

function walkWavs(dir) {
    const out = []
    for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".")) continue
        const full = join(dir, entry)
        const st = statSync(full)
        if (st.isDirectory()) out.push(...walkWavs(full))
        else if (st.isFile() && extname(entry).toLowerCase() === ".wav") out.push(full)
    }
    return out
}

const args = parseArgs(process.argv)
if (!args.src || !args.dst) {
    console.error("Usage: node scripts/convert-samples.mjs --src <source-dir> --dst <output-dir> [--dry-run]")
    console.error("  Converts 24-bit PCM .wav to 16-bit PCM, preserving sample rate and channel count.")
    console.error("  Mirrors the source directory structure under --dst.")
    process.exit(1)
}
const src = resolve(args.src)
const dst = resolve(args.dst)
const dryRun = Boolean(args["dry-run"])
if (!statSync(src).isDirectory()) {
    console.error(`Not a directory: ${src}`)
    process.exit(1)
}

const files = walkWavs(src).sort()
console.log(`Converting ${files.length} files from ${src} → ${dst}${dryRun ? "  [DRY RUN]" : ""}\n`)

let ok = 0
let copied = 0
let failed = 0
let bytesIn = 0
let bytesOut = 0
for (const file of files) {
    const rel = relative(src, file)
    const target = join(dst, rel)
    try {
        const srcBuf = readFileSync(file)
        bytesIn += srcBuf.length
        const info = readWav(srcBuf)
        if (info.format !== 1) throw new Error(`Unsupported format=${info.format} (need PCM=1)`)
        let outBuf
        if (info.bitsPerSample === 16) {
            outBuf = srcBuf
            copied++
        } else if (info.bitsPerSample === 24) {
            const pcm16 = convert24to16(srcBuf, info)
            outBuf = buildWav16(pcm16, info.channels, info.sampleRate)
            ok++
        } else {
            throw new Error(`Unsupported bitsPerSample=${info.bitsPerSample}`)
        }
        bytesOut += outBuf.length
        if (!dryRun) {
            mkdirSync(dirname(target), {recursive: true})
            writeFileSync(target, outBuf)
        }
        const ratio = (outBuf.length / srcBuf.length * 100).toFixed(1)
        console.log(`  ✓ ${rel}  ${info.bitsPerSample}-bit → 16-bit  (${(srcBuf.length / 1024).toFixed(1)}kB → ${(outBuf.length / 1024).toFixed(1)}kB, ${ratio}%)`)
    } catch (error) {
        console.error(`  ✗ ${rel}: ${error.message}`)
        failed++
    }
}

console.log(`\nDone. converted=${ok} copied=${copied} failed=${failed} total=${files.length}`)
console.log(`Size: ${(bytesIn / 1024 / 1024).toFixed(2)}MB → ${(bytesOut / 1024 / 1024).toFixed(2)}MB  (${(bytesOut / bytesIn * 100).toFixed(1)}%)`)
if (failed > 0) process.exit(1)
