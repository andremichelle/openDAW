import {readFileSync, readdirSync, statSync, writeFileSync} from "node:fs"
import {basename, extname, join, relative, resolve} from "node:path"

const API_URL = "https://api.opendaw.studio/samples/upload.php"
const LIST_URL = "https://api.opendaw.studio/samples/list.php"
const USERNAME = "openDAW"
const PASSWORD = "prototype"

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
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString("ascii", offset, offset + 4)
        const size = buffer.readUInt32LE(offset + 4)
        const body = offset + 8
        if (id === "fmt ") {
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
    const duration = dataSize / byteRate
    return {sampleRate, channels, bitsPerSample, duration}
}

async function uploadSample({filePath, name, bpm, origin, accessCode, dryRun}) {
    const buffer = readFileSync(filePath)
    const {sampleRate, duration, channels, bitsPerSample} = readWavInfo(buffer)
    console.log(`→ ${basename(filePath)}  "${name}"  ${sampleRate}Hz  ${channels}ch  ${bitsPerSample}-bit  ${duration.toFixed(3)}s  bpm=${bpm}`)
    if (dryRun) return {skipped: true}
    const form = new FormData()
    form.set("name", name)
    form.set("bpm", String(bpm))
    form.set("duration", String(duration))
    form.set("sample_rate", String(sampleRate))
    form.set("origin", origin)
    form.set("key", accessCode)
    form.append("file", new Blob([buffer], {type: "audio/wav"}), basename(filePath))
    const credentials = Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")
    const response = await fetch(API_URL, {
        method: "POST",
        headers: {"Authorization": `Basic ${credentials}`},
        body: form
    })
    const text = await response.text()
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} — ${text}`)
    }
    return {ok: true, response: text}
}

const args = parseArgs(process.argv)
const dir = args.dir
const accessCode = args["access-code"] ?? process.env.OPENDAW_ACCESS_CODE
const namesPath = args.names
const bpm = args.bpm !== undefined ? Number(args.bpm) : 120
const origin = args.origin ?? "openDAW"
const dryRun = Boolean(args["dry-run"])
const resultsPath = args.results

if (!dir) {
    console.error("Usage: node scripts/upload-samples.mjs --dir <path> [--names <map.json>] [--bpm <n>] [--origin <openDAW|recording|import>] [--access-code <code>] [--results <file.json>] [--dry-run]")
    console.error("  --results skips names already in the cloud and writes name -> uuid of every file into the file.")
    console.error("  If --access-code is omitted, OPENDAW_ACCESS_CODE env var is used.")
    process.exit(1)
}
if (!dryRun && !accessCode) {
    console.error("Missing --access-code (or set OPENDAW_ACCESS_CODE env var). Use --dry-run to preview without uploading.")
    process.exit(1)
}
if (!Number.isFinite(bpm)) {
    console.error(`Invalid --bpm value: ${args.bpm}`)
    process.exit(1)
}
if (!["openDAW", "recording", "import"].includes(origin)) {
    console.error(`Invalid --origin: ${origin}`)
    process.exit(1)
}

const dirAbs = resolve(dir)
if (!statSync(dirAbs).isDirectory()) {
    console.error(`Not a directory: ${dirAbs}`)
    process.exit(1)
}

const nameMap = namesPath ? JSON.parse(readFileSync(resolve(namesPath), "utf8")) : {}

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

const files = walkWavs(dirAbs).sort()
if (files.length === 0) {
    console.error(`No .wav files found under ${dirAbs}`)
    process.exit(1)
}

// the server picks the uuid and does not return it, the list finds it by name
const cloudNames = async () => {
    const response = await fetch(LIST_URL, {headers: {Origin: "https://opendaw.studio"}})
    if (!response.ok) throw new Error(`list.php: HTTP ${response.status}`)
    const byName = new Map()
    for (const sample of await response.json()) {
        byName.set(sample.name, [...(byName.get(sample.name) ?? []), sample.uuid])
    }
    return byName
}
const nameOf = filePath => nameMap[relative(dirAbs, filePath)] ?? nameMap[basename(filePath)] ?? basename(filePath, extname(filePath))
const known = resultsPath ? await cloudNames() : new Map()

console.log(`Uploading ${files.length} sample(s) from ${dirAbs}  bpm=${bpm}  origin=${origin}${dryRun ? "  [DRY RUN]" : ""}`)

let uploaded = 0
let failed = 0
for (const filePath of files) {
    const rel = relative(dirAbs, filePath)
    const name = nameOf(filePath)
    if (known.has(name)) {
        console.log(`  = ${rel}: already in the cloud`)
        continue
    }
    try {
        const result = await uploadSample({filePath, name, bpm, origin, accessCode, dryRun})
        if (result.ok) {
            console.log(`  ✓ ${result.response}`)
            uploaded++
        }
    } catch (error) {
        console.error(`  ✗ ${rel}: ${error.message}`)
        failed++
    }
}

console.log(`\nDone. uploaded=${uploaded} failed=${failed} total=${files.length}`)
if (resultsPath && !dryRun) {
    const after = await cloudNames()
    const results = {}
    const problems = []
    for (const filePath of files) {
        const uuids = after.get(nameOf(filePath)) ?? []
        if (uuids.length === 1) results[nameOf(filePath)] = uuids[0]
        else problems.push(`${nameOf(filePath)}: ${uuids.length} cloud samples`)
    }
    writeFileSync(resolve(resultsPath), JSON.stringify(results, null, 2) + "\n")
    console.log(`results: ${Object.keys(results).length} uuids in ${resolve(resultsPath)}`)
    problems.forEach(problem => console.error(`  ✗ ${problem}`))
    if (problems.length > 0) process.exit(1)
}
if (failed > 0) process.exit(1)
