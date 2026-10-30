// Records MIDI and audio in a real Chrome or Firefox against the running dev server and checks where takes land.
// MIDI goes over a virtual CoreMIDI cable (midi-loopback.swift), audio through BlackHole 2ch. macOS only.
// usage: node scripts/capture-audit/audit.mjs [--firefox] [--url https://localhost:8080/] [--midi-only] [--audio-only]
// diagnostics on BlackHole: [--bare] [--bisect] [--takes] [--ratchet] [--steps]
import {spawn, execFileSync} from "node:child_process"
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs"
import {createRequire} from "node:module"
import {tmpdir} from "node:os"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

const require = createRequire(import.meta.url)
const WebSocket = require("ws")
const HERE = dirname(fileURLToPath(import.meta.url))
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"
const PORT = 9334
const args = process.argv.slice(2)
const url = args.includes("--url") ? args[args.indexOf("--url") + 1] : "https://localhost:8080/"
const diagnosing = ["--bare", "--bisect", "--takes", "--ratchet", "--steps", "--page"].some(flag => args.includes(flag))
const runMidi = !args.includes("--audio-only") && !diagnosing
const runAudio = !args.includes("--midi-only") && !diagnosing
const runBare = args.includes("--bare")
const runBisect = args.includes("--bisect")
const runTakes = args.includes("--takes")
const sleep = millis => new Promise(resolve => setTimeout(resolve, millis))

const MidiScenarios = [
    {name: "90 bpm", bpm: 90},
    {name: "120 bpm", bpm: 120},
    {name: "140 bpm", bpm: 140},
    {name: "block 150 ms at 120 bpm", bpm: 120, jankAt: 5760},
    {name: "block 150 ms at 140 bpm", bpm: 140, jankAt: 5760},
    {name: "loop wraps at 120 bpm", bpm: 120, loop: true},
    {name: "loop wraps at 140 bpm", bpm: 140, loop: true},
    {name: "count-in with pickups", bpm: 120, countIn: true, pickups: true}
]
const AudioScenarios = [
    {name: "re-armed 1"}, {name: "re-armed 2"}, {name: "re-armed 3"},
    {name: "same arm 1", keepArmed: true}, {name: "same arm 2", keepArmed: true}
]

const work = mkdtempSync(join(tmpdir(), "opendaw-capture-audit-"))
const processes = []
const cleanup = () => {
    processes.forEach(child => child.kill())
    rmSync(work, {recursive: true, force: true, maxRetries: 10, retryDelay: 200})
}
process.on("exit", cleanup)
process.on("SIGINT", () => process.exit(130))

const startLoopback = async () => {
    const source = join(HERE, "midi-loopback.swift")
    const binary = join(tmpdir(), "opendaw-midi-loopback")
    if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
        execFileSync("swiftc", ["-O", source, "-o", binary], {stdio: "inherit"})
    }
    const child = spawn(binary, [], {stdio: ["ignore", "pipe", "inherit"]})
    processes.push(child)
    await new Promise((resolve, reject) => {
        child.stdout.on("data", data => {if (String(data).includes("ready")) {resolve()}})
        child.on("exit", code => reject(new Error(`midi-loopback exited with ${code}`)))
    })
}

const connect = async webSocketUrl => {
    const socket = new WebSocket(webSocketUrl, {perMessageDeflate: false})
    await new Promise((resolve, reject) => {
        socket.on("open", resolve)
        socket.on("error", reject)
    })
    let id = 0
    const pending = new Map()
    socket.on("message", raw => {
        const message = JSON.parse(raw)
        if (pending.has(message.id)) {
            pending.get(message.id)(message)
            pending.delete(message.id)
        }
    })
    const send = (method, params = {}) => new Promise(resolve => {
        pending.set(++id, resolve)
        socket.send(JSON.stringify({id, method, params}))
    })
    return {send, close: () => socket.close()}
}

// a driver navigates the page, evaluates an async function body there and returns its JSON result

// a headless Chrome refuses Web MIDI, so the window runs off screen and the fake UI flag accepts the prompts
// MIDI has no fake UI flag: the throwaway profile starts with it allowed for the origin, and it is granted again
// over the protocol, so the browser never prompts
const seedProfile = profile => {
    const origin = `${new URL(url).origin},*`
    const allowed = {[origin]: {setting: 1}}
    mkdirSync(join(profile, "Default"), {recursive: true})
    writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({
        profile: {content_settings: {exceptions: {midi: allowed, midi_sysex: allowed, media_stream_mic: allowed}}}
    }))
}

const startChrome = async () => {
    seedProfile(join(work, "profile"))
    const child = spawn(CHROME, [
        `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, "profile")}`, "--ignore-certificate-errors",
        "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
        "--no-default-browser-check", "--window-size=1600,1000", "--window-position=3000,3000", "about:blank"
    ], {stdio: "ignore"})
    processes.push(child)
    for (let attempt = 0; attempt < 50; attempt++) {
        const version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(response => response.json(), () => null)
        if (version !== null) {
            const browser = await connect(version.webSocketDebuggerUrl)
            for (const permission of [{name: "midi"}, {name: "midi", sysex: true}]) {
                await browser.send("Browser.setPermission", {origin: new URL(url).origin, permission, setting: "granted"})
            }
            browser.close()
            // navigating before the first tab settled leaves the studio on its preloader
            await sleep(3000)
            const target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(target => target.type === "page")
            const page = await connect(target.webSocketDebuggerUrl)
            return {
                navigate: url => page.send("Page.navigate", {url}),
                evaluate: async body => {
                    const {result} = await page.send("Runtime.evaluate", {
                        expression: `(async () => {\n${body}\n})()`, awaitPromise: true, returnByValue: true
                    })
                    if (result.exceptionDetails !== undefined) {throw new Error(result.exceptionDetails.exception?.description ?? "page error")}
                    return result.result.value
                },
                close: () => page.close()
            }
        }
        await sleep(200)
    }
    throw new Error("Chrome did not start")
}

// Firefox has no AudioContext.setSinkId: the profile routes all output to BlackHole, and its test preference
// grants Web MIDI without the site permission add-on
const startFirefox = async () => {
    const profile = join(work, "firefox")
    mkdirSync(profile, {recursive: true})
    writeFileSync(join(profile, "user.js"), Object.entries({
        "media.navigator.permission.disabled": true,
        "media.navigator.streams.fake": false,
        "media.autoplay.default": 0,
        "media.autoplay.blocking_policy": 0,
        "midi.prompt.testing": true,
        "dom.webmidi.enabled": true,
        "dom.sitepermsaddon-provider.enabled": false,
        "media.cubeb.output_device": "BlackHole 2ch",
        "dom.storageManager.prompt.testing": true,
        "dom.storageManager.prompt.testing.allow": true,
        "browser.shell.checkDefaultBrowser": false,
        "datareporting.policy.dataSubmissionEnabled": false
    }).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"))
    const child = spawn(FIREFOX, [`--remote-debugging-port=${PORT}`, "--profile", profile, "--new-instance",
        "--no-remote", ...(args.includes("--headed") ? [] : ["--headless"]), "about:blank"], {stdio: "ignore"})
    processes.push(child)
    for (let attempt = 0; attempt < 50; attempt++) {
        await sleep(300)
        const session = await connect(`ws://127.0.0.1:${PORT}/session`).catch(() => null)
        if (session === null) {continue}
        await session.send("session.new", {capabilities: {alwaysMatch: {acceptInsecureCerts: true}}})
        const {result: {contexts: [{context}]}} = await session.send("browsingContext.getTree", {})
        return {
            navigate: url => session.send("browsingContext.navigate", {context, url, wait: "none"}),
            evaluate: async body => {
                const response = await session.send("script.evaluate", {
                    expression: `(async () => JSON.stringify(await (async () => {\n${body}\n})()))()`,
                    target: {context}, awaitPromise: true
                })
                if (response.type === "error" || response.result?.type === "exception") {
                    throw new Error(response.message ?? response.result?.exceptionDetails?.text ?? "page error")
                }
                const value = response.result.result.value
                return value === undefined ? undefined : JSON.parse(value)
            },
            close: () => session.close()
        }
    }
    throw new Error("Firefox did not start")
}

const prelude = readFileSync(join(HERE, "page", "prelude.js"), "utf8")
const browser = args.includes("--firefox") ? "firefox" : "chrome"
const evaluate = (page, file, scenario = {}) => page.evaluate(
    `window.__scenario = ${JSON.stringify({browser, ...scenario})}\n${prelude}\n${readFileSync(file.startsWith("/") ? file : join(HERE, "page", file), "utf8")}`)

const format = value => typeof value === "number" ? value.toFixed(2) : String(value)
const table = rows => console.table(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, format(value)]))))

let failed = false
if (runMidi) {await startLoopback()}
const page = args.includes("--firefox") ? await startFirefox() : await startChrome()
await page.navigate(url)
for (let attempt = 0; attempt < 120; attempt++) {
    await sleep(500)
    const booted = await page.evaluate("return document.readyState === 'complete' && document.querySelector('#preloader') === null")
        .catch(() => false)
    if (booted === true) {break}
}
const captures = await evaluate(page, "setup.js")
if (!Array.isArray(captures)) {
    console.error("setup failed", captures)
    process.exit(1)
}
console.log("captures:", captures.join(", "))
if (runMidi) {
    const rows = []
    for (const scenario of MidiScenarios) {
        const result = await evaluate(page, "midi.js", scenario)
        // note positions and lengths are whole pulses
        const pulseMs = 1000 / (scenario.bpm * 16) + 0.001
        const ok = result.error === undefined && result.missing === 0
            && result.worstErrorMs <= pulseMs && result.worstLengthErrorMs <= pulseMs
        failed ||= !ok
        rows.push({scenario: scenario.name, ok, ...result})
    }
    console.log("MIDI: error is the recorded position minus the position heard when the key went down")
    table(rows)
}
if (args.includes("--page")) {
    console.log(JSON.stringify(await evaluate(page, args[args.indexOf("--page") + 1]), null, 1))
}
if (runBare) {
    const rows = await evaluate(page, "bare.js", {streams: 4, clicksPerStream: 20})
    console.log("Browser alone: round trip of the clicks per stream, no studio involved")
    table(Array.isArray(rows) ? rows : [rows])
}
if (args.includes("--steps")) {
    console.log("Steps: round trip of the capture's chain after recording cycles and after the events that move it")
    table(await evaluate(page, "steps.js"))
}
if (args.includes("--ratchet")) {
    const rows = []
    for (const scenario of [{studioContext: false}, {studioContext: false, keepAlive: true}, {studioContext: true}, {studioContext: true, keepAlive: true}]) {
        rows.push({...scenario, ...await evaluate(page, "ratchet.js", scenario)})
    }
    console.log("Ratchet: round trips in ms before a 3 s unpulled pause, after it, and once more")
    table(rows)
}
if (runTakes) {
    const rows = []
    for (const take of [1, 2, 3]) {rows.push({take, ...await evaluate(page, "audio.js", {keepArmed: true})})}
    table(rows)
}
if (runBisect) {
    const rows = []
    const bare = async (name, scenario) => {
        const result = await evaluate(page, "bare.js", {streams: 2, clicksPerStream: 12, ...scenario})
        if (!Array.isArray(result)) {return rows.push({step: name, ...result})}
        result.forEach(row => rows.push({step: name, ...row}))
    }
    await bare("fresh context", {})
    await bare("fresh context, keep-alive sink", {keepAlive: true})
    await bare("studio context", {studioContext: true})
    await bare("studio context, keep-alive sink", {studioContext: true, keepAlive: true})
    for (const take of [1, 2]) {
        const result = await evaluate(page, "audio.js", {})
        rows.push({step: `studio take ${take}`, minMs: result.roundTripMs, maxMs: result.roundTripMs + result.spreadMs})
        await bare(`studio context after take ${take}`, {studioContext: true})
        await bare(`fresh context after take ${take}`, {})
    }
    console.log("Bisect: round trip in ms, the bare clicks per stream and the studio takes in between")
    table(rows)
}
if (runAudio) {
    const rows = []
    for (const scenario of AudioScenarios) {
        const result = await evaluate(page, "audio.js", scenario)
        // a freshly opened stream may step by one render quantum within its first second
        const ok = result.error === undefined && result.clicks > 0 && result.spreadMs <= 128 / 44.1 + 0.1
        failed ||= !ok
        rows.push({scenario: scenario.name, ok, ...result})
    }
    const trips = rows.map(row => row.roundTripMs).filter(Number.isFinite)
    console.log("Audio: gap is where the clicks landed after the beat, round trip is the gap plus the applied latency")
    table(rows)
    console.log(`round trip ${Math.min(...trips).toFixed(2)} … ${Math.max(...trips).toFixed(2)} ms`)
    const calibration = await evaluate(page, "calibrate.js")
    const calibrated = []
    for (const scenario of [{name: "calibrated, re-armed", inputLatency: -2.0}, {name: "calibrated, same arm", keepArmed: true, inputLatency: -2.0}]) {
        const result = await evaluate(page, "audio.js", scenario)
        // a calibrated take lands on the beat, within the render quantum a fresh stream may step by
        const ok = calibration.verdict === "ok" && result.error === undefined && Math.abs(result.gapMs) <= 128 / 44.1 + 0.1
        failed ||= !ok
        calibrated.push({scenario: scenario.name, ok, gapMs: result.gapMs, spreadMs: result.spreadMs, appliedMs: result.appliedMs})
    }
    console.log(`Calibration: ${calibration.verdict}, ${format(calibration.ms)} ms, spread ${format(calibration.spreadMs)} ms, ${calibration.heard} of ${calibration.bursts} bursts`)
    table(calibrated)
}
page.close()
process.exit(failed ? 1 : 0)
