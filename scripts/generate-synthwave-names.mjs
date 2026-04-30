#!/usr/bin/env node
import {readdirSync, statSync, writeFileSync} from "node:fs"
import {extname, join, relative, resolve} from "node:path"

const MACHINE_NAME = {
    "DDD-1":         "DDD-1",
    "E-mu":          "Drumulator",
    "Linn9000":      "Linn 9000",
    "LinnDrum":      "LinnDrum",
    "Oberheim DMX":  "DMX",
    "R8":            "R-8",
    "RX5":           "RX5",
    "SCI DrumTraks": "DrumTraks",
    "Simmons SDSV":  "SDSV",
    "TR-626":        "TR-626",
    "TR-707":        "TR-707"
}

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
if (!args.dir || !args.out) {
    console.error("Usage: node scripts/generate-synthwave-names.mjs --dir <samples-root> --out <names.json>")
    process.exit(1)
}
const root = resolve(args.dir)
const out = resolve(args.out)
const files = walkWavs(root).sort()

const compact = (display) => display
    .replace(/\bHi[ -]?Hat\b/gi, "Hihat")
    .replace(/\bSide Stick\b/gi, "Rim")
    .replace(/\s+Classic\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()

const entries = []
for (const file of files) {
    const rel = relative(root, file)
    const parts = rel.split("/")
    const dirMachine = parts[0]
    const machine = MACHINE_NAME[dirMachine] ?? dirMachine
    const stem = parts[parts.length - 1].replace(/\.wav$/i, "")
    const sound = stem.replace(/\s*SD_80s_[^/]*$/i, "").trim()
    const display = compact(`${machine} ${sound}`)
    entries.push({rel, display})
}

const names = {}
for (const entry of entries) names[entry.rel] = entry.display

const stemMaxN = new Map()
const trailingNumber = (display) => {
    const match = display.match(/^(.+?)\s+(\d+)$/)
    return match ? {stem: match[1], n: parseInt(match[2], 10)} : null
}
for (const entry of entries) {
    const parsed = trailingNumber(entry.display)
    if (parsed === null) continue
    stemMaxN.set(parsed.stem, Math.max(stemMaxN.get(parsed.stem) ?? 0, parsed.n))
}

const seen = new Map()
const renamed = []
const sortedEntries = [...entries].sort((a, b) => a.rel.localeCompare(b.rel))
for (const entry of sortedEntries) {
    const current = names[entry.rel]
    if (!seen.has(current)) {
        seen.set(current, entry.rel)
        continue
    }
    const parsed = trailingNumber(current)
    const stem = parsed?.stem ?? current
    const next = (stemMaxN.get(stem) ?? 0) + 1
    stemMaxN.set(stem, next)
    const replacement = `${stem} ${next}`
    names[entry.rel] = replacement
    seen.set(replacement, entry.rel)
    renamed.push({rel: entry.rel, from: current, to: replacement})
}

writeFileSync(out, JSON.stringify(names, null, 2) + "\n")

const displayCounts = new Map()
for (const display of Object.values(names)) {
    displayCounts.set(display, (displayCounts.get(display) ?? 0) + 1)
}
const dupes = [...displayCounts.entries()].filter(([, count]) => count > 1)

console.log(`Wrote ${Object.keys(names).length} entries to ${out}`)
if (renamed.length > 0) {
    console.log(`\nRenumbered to avoid collisions (${renamed.length}):`)
    for (const r of renamed) console.log(`  ${r.from}  →  ${r.to}   [${r.rel}]`)
}
if (dupes.length > 0) {
    console.log(`\nDuplicate display names still present (${dupes.length}):`)
    for (const [name, count] of dupes.sort()) console.log(`  ${count}× ${name}`)
} else {
    console.log("All display names are unique.")
}
