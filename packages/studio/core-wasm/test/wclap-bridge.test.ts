// The WCLAP host bridge against the real Signalsmith Basics bundle (MIT, test/assets/basics.wclap.tar.gz):
// describe, load, audio, parameter mapping (ids above 2^31, unit/real kinds, folded modulation and its
// clearing), values queued before the plugin is up, state round trip, fault containment, load tracking.
// Audio port layouts against a minimal test plugin (test/assets/audio-ports.c).
// Device panel sessions, request_show and request_hide against the device-panel-demo (test/assets/device-panel.c).
// An audio effect with a device panel against WetChorus (test/assets/wet-chorus.wasm, open-webclap ports/wet-chorus,
// WetChorus by Ronald Klarenbeek, MIT).
// A granular instrument with a device panel, its sample sent from the page, against Xenon (test/assets/xenon.wasm,
// opendaw-commons wclaps/xenon).
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {gunzipSync} from "node:zlib"
import {UUID} from "@opendaw/lib-std"
import {WclapBundle, WclapBundleFile, WclapParamInfo, WclapStatus} from "@opendaw/studio-adapters"
import {WclapBridges, WclapHostCallbacks} from "../src/wclap/wclap-bridge"
import {createWclapDescriber} from "../src/wclap/wclap-describer"

const BASICS = path.resolve(__dirname, "assets", "basics.wclap.tar.gz")
// audio-ports.c, one plugin per layout, silent unless given exactly what it declared: out<ports>x<channels> writes
// 0.5 / (1 + port * 16 + channel), in<ports>x<channels> plays input port 0's first channel left, all others summed right
const AUDIO_PORTS = path.resolve(__dirname, "assets", "audio-ports.wasm")
const REVERB = "uk.co.signalsmith.basics.reverb"
const IN0 = 4096, IN1 = 4096 + 512, OUT0 = 4096 + 1024, OUT1 = 4096 + 1536
const UNIT = 0, FLOAT = 2

const untar = (bytes: Uint8Array): Array<WclapBundleFile> => {
    const files: Array<WclapBundleFile> = []
    const text = (offset: number, length: number): string => {
        const end = bytes.indexOf(0, offset)
        return new TextDecoder().decode(bytes.subarray(offset, Math.min(end === -1 ? offset + length : end, offset + length)))
    }
    const state = {offset: 0}
    while (state.offset + 512 <= bytes.length && bytes[state.offset] !== 0) {
        const header = state.offset
        const size = parseInt(text(header + 124, 12).trim() || "0", 8)
        const type = String.fromCharCode(bytes[header + 156])
        const prefix = text(header + 345, 155)
        const name = (prefix.length > 0 ? `${prefix}/` : "") + text(header, 100)
        if (type === "0" || type === "\0") {
            files.push({path: name.substring(name.indexOf("/") + 1), bytes: bytes.slice(header + 512, header + 512 + size)})
        }
        state.offset = header + 512 + Math.ceil(size / 512) * 512
    }
    return files
}

const basics: WclapBundle = {files: untar(gunzipSync(readFileSync(BASICS)))}
const audioPortsBundle: WclapBundle = {files: [{path: "module.wasm", bytes: new Uint8Array(readFileSync(AUDIO_PORTS))}]}
// device-panel.c, the opendaw-commons device-panel-demo, once with and once without its opendaw.device-panel/1 extension
const wasmBundle = (name: string): WclapBundle =>
    ({files: [{path: "module.wasm", bytes: new Uint8Array(readFileSync(path.resolve(__dirname, "assets", name)))}]})
const devicePanelBundle = wasmBundle("device-panel.wasm")
const devicePanelNoExtensionBundle = wasmBundle("device-panel-no-extension.wasm")
const DEVICE_PANEL = "studio.opendaw.commons.device-panel-demo"
const wetChorusBundle = wasmBundle("wet-chorus.wasm")
const WET_CHORUS = "studio.opendaw.commons.wet-chorus"
const xenonBundle = wasmBundle("xenon.wasm")
const XENON = "studio.opendaw.commons.xenon"

type Host = {
    bridges: WclapBridges
    imports: Record<string, (...args: Array<number>) => number | void>
    memory: WebAssembly.Memory
    statuses: Array<WclapStatus>
    params: Array<WclapParamInfo>
    states: Array<Uint8Array>
    reported: Array<[number, number, number]>
    loads: Array<Promise<unknown>>
    saveRequests: number
    guiSends: number
    lastGui: ArrayBuffer
    shows: Array<string>
    hovered: Array<number>
    hides: Array<string>
}

const createHost = (bundle: WclapBundle | (() => Promise<WclapBundle>) = basics): Host => {
    const memory = new WebAssembly.Memory({initial: 16})
    const host: Host = {
        bridges: undefined as unknown as WclapBridges, imports: {}, memory,
        statuses: [], params: [], states: [], reported: [], loads: [], saveRequests: 0, guiSends: 0, lastGui: new ArrayBuffer(0), shows: [], hides: [], hovered: []
    }
    const callbacks: WclapHostCallbacks = {
        loadBundle: () => typeof bundle === "function" ? bundle() : Promise.resolve(bundle),
        sendGui: (_uuid, bytes) => {
            host.guiSends++
            host.lastGui = bytes
        },
        sendState: (_uuid, bytes) => host.states.push(new Uint8Array(bytes)),
        sendParams: (_uuid, list) => {host.params = [...list]},
        sendParam: (_uuid, id, value, gesture) => host.reported.push([id, value, gesture]),
        sendHovered: (_uuid, paramId) => host.hovered.push(paramId),
        requestGuiResize: () => {},
        requestGuiShow: uuid => host.shows.push(uuid),
        requestGuiHide: uuid => host.hides.push(uuid),
        sendStatus: (_uuid, status) => host.statuses.push(status),
        requestSave: () => {host.saveRequests++},
        track: promise => host.loads.push(promise)
    }
    host.bridges = new WclapBridges(memory, 48000, callbacks)
    host.imports = host.bridges.imports()
    const u8 = new Uint8Array(memory.buffer)
    const input = new Float32Array(memory.buffer, IN0, 128)
    input.forEach((_, index) => input[index] = Math.sin(index * 0.2) * 0.5)
    new Float32Array(memory.buffer, IN1, 128).set(input)
    u8.set(new Uint8Array(16).map((_, index) => index + 1), 0)
    return host
}

const load = (host: Host, clapId: string = REVERB, url: string = "basics"): number => {
    const u8 = new Uint8Array(host.memory.buffer)
    u8.set(new TextEncoder().encode(url), 16)
    u8.set(new TextEncoder().encode(clapId), 1024)
    const handle = host.imports.host_wclap_create(0) as number
    host.imports.host_wclap_load(handle, 16, url.length, 1024, clapId.length)
    return handle
}

const process = (host: Host, handle: number, frames: number = 128): number =>
    host.imports.host_wclap_process(handle, IN0, IN1, OUT0, OUT1, frames, 120, 0, 4) as number

const rms = (host: Host, handle: number, chunks: number): number => {
    const sum = Array.from({length: chunks}).reduce((sum: number) => {
        process(host, handle)
        const out = new Float32Array(host.memory.buffer, OUT0, 128)
        return sum + out.reduce((acc, value) => acc + value * value, 0)
    }, 0)
    return Math.sqrt(sum / (chunks * 128))
}

const ready = async (host: Host, handle: number): Promise<void> => {
    await Promise.all(host.loads)
    expect(host.statuses.at(-1)?.state).toBe("ready")
    expect(process(host, handle)).toBe(1)
}

const param = (host: Host, name: string): WclapParamInfo => {
    const info = host.params.find(entry => entry.name === name)
    if (info === undefined) {throw new Error(`no param ${name}`)}
    return info
}

describe("wclap bridge", () => {
    it("describes the bundle's plugins once per url", async () => {
        const host = createHost()
        const plugins = await host.bridges.describe("basics")
        expect(plugins.map(({clapId}) => clapId)).toContain(REVERB)
        expect(plugins.find(({clapId}) => clapId === REVERB)?.features).toContain("audio-effect")
        expect(await host.bridges.describe("basics")).toBe(plugins)
    })

    it("passes through until loaded, then renders and reports status and parameters", async () => {
        const host = createHost()
        const handle = load(host)
        expect(process(host, handle)).toBe(0)
        expect(host.statuses.map(({state}) => state)).toEqual(["loading"])
        await ready(host, handle)
        expect(host.params.length).toBe(10)
        expect(host.params.some(({id}) => id > 0x7FFFFFFF)).toBe(true)
        expect(rms(host, handle, 100)).toBeGreaterThan(0.1)
    })

    it("maps unit values into the range, takes real values as is and folds modulation", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        const wet = param(host, "wet")
        const dry = param(host, "dry")
        // the plugin smooths gains and the reverb tail decays, so every reading follows a settling run
        const settled = (): number => {
            rms(host, handle, 200)
            return rms(host, handle, 100)
        }
        host.imports.host_wclap_param(handle, wet.id | 0, UNIT, 0, NaN)
        host.imports.host_wclap_param(handle, dry.id | 0, UNIT, 0, NaN)
        expect(settled()).toBeLessThan(0.05)
        host.imports.host_wclap_param(handle, dry.id | 0, FLOAT, 1, NaN)
        const dryFull = settled()
        expect(dryFull).toBeGreaterThan(1.0)
        host.imports.host_wclap_param(handle, dry.id | 0, UNIT, 0.0, 1.0)
        expect(settled()).toBeCloseTo(dryFull, 1)
        host.imports.host_wclap_param(handle, dry.id | 0, UNIT, 0.0, 0.0)
        expect(settled()).toBeLessThan(0.05)
    })

    it("keeps host values queued before the plugin is up and applies them with the first process call", async () => {
        const probe = createHost()
        const probeHandle = load(probe)
        await ready(probe, probeHandle)
        const wet = param(probe, "wet")
        const dry = param(probe, "dry")
        const host = createHost()
        const handle = load(host)
        host.imports.host_wclap_param(handle, wet.id | 0, UNIT, 0, NaN)
        host.imports.host_wclap_param(handle, dry.id | 0, UNIT, 0, NaN)
        await ready(host, handle)
        expect(rms(host, handle, 100)).toBeLessThan(0.15)
    })

    it("keeps every queued host value, however many ids arrive before the plugin is up", async () => {
        const probe = createHost()
        const probeHandle = load(probe)
        await ready(probe, probeHandle)
        const wet = param(probe, "wet")
        const dry = param(probe, "dry")
        const known = new Set(probe.params.map(({id}) => id))
        const unknown = Array.from({length: 1000}, (_, index) => 0x10000 + index).filter(id => !known.has(id)).slice(0, 200)
        const host = createHost()
        const handle = load(host)
        unknown.forEach(id => host.imports.host_wclap_param(handle, id, UNIT, 0.5, NaN))
        host.imports.host_wclap_param(handle, wet.id | 0, UNIT, 0, NaN)
        host.imports.host_wclap_param(handle, dry.id | 0, UNIT, 0, NaN)
        await ready(host, handle)
        expect(rms(host, handle, 100)).toBeLessThan(0.15)
    })

    it("round-trips the plugin state through save and load", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        const dry = param(host, "dry")
        host.imports.host_wclap_param(handle, dry.id | 0, FLOAT, 0.125, NaN)
        rms(host, handle, 2)
        host.bridges.saveState("01020304-0506-0708-090a-0b0c0d0e0f10")
        expect(host.states.length).toBe(1)
        const base64 = Buffer.from(host.states[0]).toString("base64")
        const other = createHost()
        const otherHandle = load(other)
        new Uint8Array(other.memory.buffer).set(new TextEncoder().encode(base64), 2048)
        other.imports.host_wclap_state(otherHandle, 2048, base64.length)
        await ready(other, otherHandle)
        expect(param(other, "dry").value).toBeCloseTo(0.125, 5)
        other.bridges.saveState("01020304-0506-0708-090a-0b0c0d0e0f10")
        expect(other.states.length).toBe(0)
    })

    it("round-trips the plugin state as raw bytes, before and after the plugin is up", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        host.imports.host_wclap_param(handle, param(host, "dry").id | 0, FLOAT, 0.125, NaN)
        rms(host, handle, 2)
        host.bridges.saveState("01020304-0506-0708-090a-0b0c0d0e0f10")
        const bytes = host.states[0]
        const before = createHost()
        const beforeHandle = load(before)
        new Uint8Array(before.memory.buffer).set(new Uint8Array(bytes), 2048)
        before.imports.host_wclap_state_bytes(beforeHandle, 2048, bytes.byteLength)
        await ready(before, beforeHandle)
        expect(param(before, "dry").value).toBeCloseTo(0.125, 5)
        before.bridges.saveState("01020304-0506-0708-090a-0b0c0d0e0f10")
        expect(before.states.length).toBe(0)
        const after = createHost()
        const afterHandle = load(after)
        await ready(after, afterHandle)
        new Uint8Array(after.memory.buffer).set(new Uint8Array(bytes), 2048)
        after.imports.host_wclap_state_bytes(afterHandle, 2048, bytes.byteLength)
        after.reported.length = 0
        after.bridges.receive("01020304-0506-0708-090a-0b0c0d0e0f10", new TextEncoder().encode("{}").buffer)
        rms(after, afterHandle, 4)
        const reports = after.reported.filter(([id]) => id === param(after, "dry").id)
        expect(reports.length).toBe(1)
        expect(reports[0][1]).toBeCloseTo(0.125, 5)
    })

    it("reports a failed load and passes through, without throwing into the engine", async () => {
        const host = createHost({files: [{path: "module.wasm", bytes: new Uint8Array([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0])}]})
        const handle = load(host)
        await Promise.all(host.loads)
        expect(host.statuses.at(-1)?.state).toBe("failed")
        expect(process(host, handle)).toBe(0)
    })

    it("reports a missing plugin id and forgets a failed bundle so the next load retries", async () => {
        const attempts = {count: 0}
        const host = createHost(() => {
            attempts.count++
            return attempts.count === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(basics)
        })
        const handle = load(host)
        await Promise.all(host.loads)
        expect(host.statuses.at(-1)).toEqual({state: "failed", message: "offline", inputs: []})
        await expect(host.bridges.describe("basics")).resolves.toHaveLength(6)
        expect(attempts.count).toBe(2)
        const missing = load(host, "uk.co.signalsmith.basics.nope", "basics")
        await Promise.all(host.loads)
        expect(host.statuses.at(-1)?.message).toContain("not in bundle")
        expect(process(host, missing)).toBe(0)
        expect(process(host, handle)).toBe(0)
    })

    it("reloads a failed plugin when the same url and id arrive again (rebind)", async () => {
        const attempts = {count: 0}
        const host = createHost(() => {
            attempts.count++
            return attempts.count === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(basics)
        })
        const handle = load(host)
        await Promise.all(host.loads)
        expect(host.statuses.at(-1)?.state).toBe("failed")
        expect(load(host)).toBe(handle)
        await ready(host, handle)
        expect(attempts.count).toBe(2)
    })

    it("reloads a failed plugin on retry of its url once the bundle is back (re-import of a deleted bundle)", async () => {
        const attempts = {count: 0}
        const host = createHost(() => {
            attempts.count++
            return attempts.count === 1 ? Promise.reject(new Error("not stored")) : Promise.resolve(basics)
        })
        const handle = load(host)
        await Promise.all(host.loads)
        expect(host.statuses.at(-1)?.state).toBe("failed")
        host.bridges.retry("elsewhere")
        await Promise.all(host.loads)
        expect(attempts.count).toBe(1)
        expect(host.statuses.at(-1)?.state).toBe("failed")
        host.bridges.retry("basics")
        await ready(host, handle)
        expect(attempts.count).toBe(2)
    })

    it("leaves a loaded plugin alone on retry", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        const statuses = host.statuses.length
        host.bridges.retry("basics")
        await Promise.all(host.loads)
        expect(host.statuses.length).toBe(statuses)
        expect(process(host, handle)).toBe(1)
    })

    it("keeps a loaded plugin when the same url and id arrive again", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        const statuses = host.statuses.length
        load(host)
        await Promise.all(host.loads)
        expect(host.statuses.length).toBe(statuses)
        expect(process(host, handle)).toBe(1)
    })

    it("never reports a host value back, so a folded modulation cannot drift the base", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        const dry = param(host, "dry")
        expect(dry.flags & (1 << 10)).toBe(0) // not modulatable: the modulation is folded into the value
        host.reported.length = 0
        // a page message makes the bridge poll the plugin's values on the next chunk (Cmajor emits no events)
        const poke = new TextEncoder().encode("{}").buffer
        Array.from({length: 8}).forEach((_, index) => {
            host.imports.host_wclap_param(handle, dry.id | 0, UNIT, 0.5, index % 2 === 0 ? 0.25 : -0.25)
            process(host, handle)
            host.bridges.receive("01020304-0506-0708-090a-0b0c0d0e0f10", poke)
            process(host, handle)
        })
        expect(host.reported.filter(([id]) => id === dry.id)).toEqual([])
    })

    it("sweeps the values after a page message and reports a plugin-side change once", async () => {
        const source = createHost()
        const sourceHandle = load(source)
        await ready(source, sourceHandle)
        source.imports.host_wclap_param(sourceHandle, param(source, "dry").id | 0, FLOAT, 0.125, NaN)
        rms(source, sourceHandle, 2)
        source.bridges.saveState("01020304-0506-0708-090a-0b0c0d0e0f10")
        const base64 = Buffer.from(source.states[0]).toString("base64")
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        const dry = param(host, "dry")
        // a state load changes values behind the host's back, like a page edit in a plugin without events
        new Uint8Array(host.memory.buffer).set(new TextEncoder().encode(base64), 2048)
        host.imports.host_wclap_state(handle, 2048, base64.length)
        host.reported.length = 0
        process(host, handle)
        expect(host.reported).toEqual([])
        const poke = new TextEncoder().encode("{}").buffer
        host.bridges.receive("01020304-0506-0708-090a-0b0c0d0e0f10", poke)
        rms(host, handle, 4)
        host.bridges.receive("01020304-0506-0708-090a-0b0c0d0e0f10", poke)
        rms(host, handle, 4)
        const reports = host.reported.filter(([id]) => id === dry.id)
        expect(reports.length).toBe(1)
        expect(reports[0][1]).toBeCloseTo(0.125, 5)
    })

    it("describes a bundle without an engine (main-thread describer)", async () => {
        const describe = createWclapDescriber(() => Promise.resolve(basics))
        const plugins = await describe("basics")
        expect(plugins).toHaveLength(6)
        expect(plugins.find(({clapId}) => clapId === REVERB)?.vendor.length).toBeGreaterThan(0)
    })

    it("renders sub-quantum chunks", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        expect(process(host, handle, 1)).toBe(1)
        expect(process(host, handle, 37)).toBe(1)
    })

    it("opens the gui with its resize answers and passes sizes through when the plugin cannot resize", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        const uuid = UUID.toString(new Uint8Array(16).map((_, index) => index + 1) as UUID.Bytes)
        expect(host.bridges.resizeGui(uuid, 320, 200)).toEqual({width: 320, height: 200})
        const gui = host.bridges.openGui(uuid)
        expect(gui.width).toBeGreaterThan(0)
        expect(gui.aspectRatio).toBeGreaterThanOrEqual(0)
        const resized = host.bridges.resizeGui(uuid, 320, 200)
        expect(resized.width).toBeGreaterThan(0)
        expect(host.statuses.at(-1)?.state).toBe("ready")
        expect(process(host, handle)).toBe(1)
    })

    // the plugin's page sends reach the host only while a gui session is open
    it("keeps the gui while any session is open and closes it with the last close", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        const uuid = UUID.toString(new Uint8Array(16).map((_, index) => index + 1) as UUID.Bytes)
        const talks = (): boolean => {
            const before = host.guiSends
            // CBOR "ready", the first message of the Basics page, answered with the plugin state
            host.bridges.receive(uuid, new Uint8Array([0x65, ...new TextEncoder().encode("ready")]).buffer)
            rms(host, handle, 4)
            return host.guiSends > before
        }
        expect(talks()).toBe(false)
        const first = host.bridges.openGui(uuid)
        expect(talks()).toBe(true)
        const second = host.bridges.openGui(uuid)
        expect(second).toEqual(first)
        host.bridges.closeGui(uuid)
        expect(talks()).toBe(true)
        host.bridges.closeGui(uuid)
        expect(talks()).toBe(false)
        // a close without an open session is ignored, the next open counts as the first
        host.bridges.closeGui(uuid)
        host.bridges.openGui(uuid)
        expect(talks()).toBe(true)
        host.bridges.closeGui(uuid)
        expect(talks()).toBe(false)
        expect(host.statuses.at(-1)?.state).toBe("ready")
    })

    const loadAudioPorts = (shape: string): [Host, number] => {
        const host = createHost(audioPortsBundle)
        new Float32Array(host.memory.buffer, IN0, 128).fill(0.25)
        new Float32Array(host.memory.buffer, IN1, 128).fill(0.75)
        return [host, load(host, `test.audio-ports.${shape}`, "audio-ports")]
    }

    const played = (host: Host): [Array<number>, Array<number>] =>
        [Array.from(new Float32Array(host.memory.buffer, OUT0, 128)), Array.from(new Float32Array(host.memory.buffer, OUT1, 128))]

    const audioPorts = async (shape: string): Promise<[Array<number>, Array<number>]> => {
        const [host, handle] = loadAudioPorts(shape)
        await ready(host, handle)
        return played(host)
    }

    it("plays a mono output port on both channels", async () => {
        const [left, right] = await audioPorts("out1x1")
        expect(left).toEqual(new Array(128).fill(0.5))
        expect(right).toEqual(new Array(128).fill(0.5))
    })

    it("gives every declared output port a buffer and plays port 0", async () => {
        const [left, right] = await audioPorts("out2x2")
        expect(left).toEqual(new Array(128).fill(0.5))
        expect(right).toEqual(new Array(128).fill(Math.fround(0.25)))
    })

    it("gives an output port all its channels and plays the first two", async () => {
        const [left, right] = await audioPorts("out1x8")
        expect(left).toEqual(new Array(128).fill(0.5))
        expect(right).toEqual(new Array(128).fill(Math.fround(0.25)))
    })

    it("refuses a plugin that declares more channels than the limit", async () => {
        const [host] = loadAudioPorts("out1x1025")
        await Promise.all(host.loads)
        expect(host.statuses.at(-1)?.state).toBe("failed")
        expect(host.statuses.at(-1)?.message).toContain("output port 0 has 1025 channels")
    })

    it("feeds a mono input port the average of left and right", async () => {
        const [left, right] = await audioPorts("in1x1")
        expect(left).toEqual(new Array(128).fill(0.5))
        expect(right).toEqual(new Array(128).fill(0))
    })

    it("gives an input port all its channels, silent past the first two", async () => {
        const [left, right] = await audioPorts("in1x8")
        expect(left).toEqual(new Array(128).fill(0.25))
        expect(right).toEqual(new Array(128).fill(0.75))
    })

    it("gives every declared input port its channels", async () => {
        const [host, handle] = loadAudioPorts("in2x2")
        await ready(host, handle)
        expect(played(host)).toEqual([new Array(128).fill(0.25), new Array(128).fill(0.75)])
        host.imports.host_wclap_input(handle, 1, IN0, IN1, 128)
        expect(process(host, handle)).toBe(1)
        expect(played(host)).toEqual([new Array(128).fill(0.25), new Array(128).fill(1.75)])
    })

    // a page that polls (SC Dark every 100 ms, ProTracker at 60 Hz) sends faster than the save delay of 40 chunks
    it("a page that polls faster than the save delay still gets the state saved while it is open", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        Array.from({length: 400}).forEach((_, chunk) => {
            if (chunk % 30 === 0) {host.bridges.receive("01020304-0506-0708-090a-0b0c0d0e0f10", new TextEncoder().encode("{}").buffer)}
            process(host, handle)
        })
        expect(host.saveRequests).toBeGreaterThan(0)
    })

    describe("device panel", () => {
        const uuid = UUID.toString(new Uint8Array(16).map((_, index) => index + 1) as UUID.Bytes)
        // page messages of device-panel.c: 1 poll, 5 request_show, 6 request_hide, 7 param-hovered (id at byte 4)
        const page = (host: Host, type: number): void => host.bridges.receive(uuid, new Uint8Array([type]).buffer)
        const talks = (host: Host): boolean => {
            const before = host.guiSends
            page(host, 1)
            return host.guiSends > before
        }
        const loadPanel = async (bundle: WclapBundle = devicePanelBundle): Promise<[Host, number]> => {
            const host = createHost(bundle)
            const handle = load(host, DEVICE_PANEL, "device-panel")
            await ready(host, handle)
            return [host, handle]
        }

        it("reports a plugin with the feature and the extension as one with a panel, others without", async () => {
            const [host] = await loadPanel()
            expect(host.statuses.at(-1)).toMatchObject({state: "ready", editor: true, panel: true})
            const plain = createHost()
            await ready(plain, load(plain))
            expect(plain.statuses.at(-1)).toMatchObject({state: "ready", editor: true, panel: false})
        })

        it("opens the panel page with its width as a gui session, the window page stays the webview's", async () => {
            const [host] = await loadPanel()
            expect(talks(host)).toBe(false)
            expect(host.bridges.openPanel(uuid, 176)).toEqual({uri: "/index.html?panel", width: 176})
            expect(talks(host)).toBe(true)
            const window = host.bridges.openGui(uuid)
            expect(window.uri).toBe("/index.html")
            expect(window.width).toBe(480)
            expect(window.height).toBe(320)
            host.bridges.closeGui(uuid)
            expect(talks(host)).toBe(true)
            host.bridges.closeGui(uuid)
            expect(talks(host)).toBe(false)
        })

        it("opens no panel for a plugin without the feature and counts no session", async () => {
            const host = createHost()
            await ready(host, load(host))
            expect(host.bridges.openPanel(uuid, 176)).toEqual({uri: "", width: 0})
            host.bridges.openGui(uuid)
            host.bridges.closeGui(uuid)
            host.bridges.closeGui(uuid)
            expect(host.bridges.openPanel(uuid, 176)).toEqual({uri: "", width: 0})
        })

        it("logs a plugin that lists the feature without the extension and shows it without a panel", async () => {
            const lines: Array<string> = []
            const log = console.log
            console.log = (...args: Array<unknown>) => {lines.push(args.join(" "))}
            const loaded = await loadPanel(devicePanelNoExtensionBundle).finally(() => {console.log = log})
            const [host] = loaded
            expect(host.statuses.at(-1)).toMatchObject({state: "ready", editor: true, panel: false})
            expect(lines.some(line => line.includes(DEVICE_PANEL) && line.includes("opendaw.device-panel/1"))).toBe(true)
            expect(host.bridges.openPanel(uuid, 176)).toEqual({uri: "", width: 0})
            expect(host.bridges.openGui(uuid).uri).toBe("/index.html")
        })

        it("passes request_show and request_hide on while a page is open and refuses them otherwise", async () => {
            const [host] = await loadPanel()
            page(host, 5)
            page(host, 6)
            expect(host.shows).toEqual([])
            expect(host.hides).toEqual([])
            host.bridges.openPanel(uuid, 176)
            page(host, 5)
            expect(host.shows).toEqual([uuid])
            page(host, 6)
            expect(host.hides).toEqual([uuid])
            host.bridges.closeGui(uuid)
            page(host, 5)
            expect(host.shows).toEqual([uuid])
        })

        it("reports the hovered fader to the host, so right-click and double-click reach the gain parameter", async () => {
            const [host] = await loadPanel()
            host.bridges.openPanel(uuid, 176)
            const hover = (id: number): void => {
                const message = new DataView(new ArrayBuffer(8))
                message.setUint8(0, 7)
                message.setUint32(4, id, true)
                host.bridges.receive(uuid, message.buffer)
            }
            hover(0)
            hover(0xffffffff)
            hover(3)
            expect(host.hovered).toEqual([0, -1, -1])
            expect(param(host, "Gain").id).toBe(0)
        })
    })

    describe("WetChorus, an audio effect with a device panel", () => {
        const uuid = UUID.toString(new Uint8Array(16).map((_, index) => index + 1) as UUID.Bytes)
        const loadChorus = async (): Promise<[Host, number]> => {
            const host = createHost(wetChorusBundle)
            const handle = load(host, WET_CHORUS, "wet-chorus")
            await ready(host, handle)
            return [host, handle]
        }
        it("describes itself as an audio effect that offers a device panel", async () => {
            const plugins = await createHost(wetChorusBundle).bridges.describe("wet-chorus")
            expect(plugins.map(({clapId}) => clapId)).toEqual([WET_CHORUS])
            expect(plugins[0].features).toEqual(expect.arrayContaining(["audio-effect", "chorus", "opendaw:device-panel"]))
        })

        it("shows its whole panel scaled into the device panel and in a 768 x 512 window from 50 to 125 %", async () => {
            const [host] = await loadChorus()
            expect(host.statuses.at(-1)).toMatchObject({state: "ready", editor: true, panel: true})
            expect(host.bridges.openPanel(uuid, 176)).toEqual({uri: "/index.html", width: 264})
            expect(host.bridges.openGui(uuid)).toMatchObject({uri: "/index.html", width: 768, height: 512, resizable: true})
            expect(host.bridges.resizeGui(uuid, 100, 100)).toEqual({width: 384, height: 256})
            expect(host.bridges.resizeGui(uuid, 2000, 2000)).toEqual({width: 960, height: 640})
            expect(host.bridges.resizeGui(uuid, 1152, 900)).toEqual({width: 960, height: 640})
        })

        it("lists Speed, Depth and Mode at their upstream defaults", async () => {
            const [host] = await loadChorus()
            expect(host.params.map(({name, min, max, defaultValue}) => [name, min, max, defaultValue]))
                .toEqual([["Speed", 0, 10, 5], ["Depth", 0, 1, 0], ["Mode", 0, 180, 180]])
        })

        it("plays a fully wet chorus, both outputs differ from the input and from each other", async () => {
            const [host, handle] = await loadChorus()
            const level = rms(host, handle, 200)
            expect(level).toBeGreaterThan(0.01)
            const [left, right] = [new Float32Array(host.memory.buffer, OUT0, 128), new Float32Array(host.memory.buffer, OUT1, 128)]
            const input = new Float32Array(host.memory.buffer, IN0, 128)
            expect(Array.from(left)).not.toEqual(Array.from(input))
            expect(Array.from(left)).not.toEqual(Array.from(right))
        })

        it("saves upstream's state format and reads it back into the same values", async () => {
            const [host, handle] = await loadChorus()
            host.imports.host_wclap_param(handle, param(host, "Speed").id | 0, FLOAT, 2.5, NaN)
            host.imports.host_wclap_param(handle, param(host, "Depth").id | 0, FLOAT, 1, NaN)
            host.imports.host_wclap_param(handle, param(host, "Mode").id | 0, FLOAT, 90, NaN)
            rms(host, handle, 2)
            host.bridges.saveState(uuid)
            const words = new Int32Array(host.states[0].slice().buffer)
            expect(Array.from(words)).toEqual([1, 65, 16, 1, 32])
            const other = createHost(wetChorusBundle)
            const otherHandle = load(other, WET_CHORUS, "wet-chorus")
            const bytes = host.states[0]
            new Uint8Array(other.memory.buffer).set(new TextEncoder().encode(Buffer.from(bytes).toString("base64")), 2048)
            other.imports.host_wclap_state(otherHandle, 2048, Buffer.from(bytes).toString("base64").length)
            await ready(other, otherHandle)
            expect(param(other, "Speed").value).toBeCloseTo(2.5, 9)
            expect(param(other, "Depth").value).toBe(1)
            expect(param(other, "Mode").value).toBeCloseTo(90, 9)
        })

        it("snaps a host value between detents onto the nearest of the 65 knob positions in its saved state", async () => {
            const [host, handle] = await loadChorus()
            host.imports.host_wclap_param(handle, param(host, "Speed").id | 0, FLOAT, 5.07, NaN)
            rms(host, handle, 1)
            host.bridges.saveState(uuid)
            expect(new Int32Array(host.states[0].slice().buffer)[2]).toBe(32)
        })

        it("answers a page poll with its meters and values, and takes a page edit as a host gesture", async () => {
            const [host, handle] = await loadChorus()
            host.bridges.openPanel(uuid, 176)
            rms(host, handle, 50)
            host.bridges.receive(uuid, new Uint8Array([1]).buffer)
            // status: type, then the IN, OUT L, OUT R meters (float32, 0..1 over -72..+12 dB) and the three values (float64)
            const status = new DataView(host.lastGui)
            expect(status.byteLength).toBe(40)
            expect(status.getUint8(0)).toBe(1)
            for (const offset of [4, 8, 12]) {expect(status.getFloat32(offset, true)).toBeGreaterThan(0.5)}
            expect([16, 24, 32].map(offset => status.getFloat64(offset, true))).toEqual([5, 0, 180])
            const edit = (type: number, value: number = 0): void => {
                const message = new DataView(new ArrayBuffer(type === 3 ? 16 : 8))
                message.setUint8(0, type)
                message.setUint32(4, 2, true)
                if (type === 3) {message.setFloat64(8, value, true)}
                host.bridges.receive(uuid, message.buffer)
            }
            host.reported.length = 0
            edit(2)
            edit(3, 45)
            edit(4)
            rms(host, handle, 2)
            expect(host.reported).toEqual([[2, 0, 1], [2, 45, 0], [2, 0, 2]])
        })
    })
    describe("Xenon, a granular instrument with a device panel", () => {
        const uuid = UUID.toString(new Uint8Array(16).map((_, index) => index + 1) as UUID.Bytes)
        const RATE = 48000
        const loadXenon = async (bundle: WclapBundle = xenonBundle): Promise<[Host, number]> => {
            const host = createHost(bundle)
            const handle = load(host, XENON, "xenon")
            await ready(host, handle)
            return [host, handle]
        }
        // the page's upload: begin (frames, rate, name), chunks of 16-bit mono, commit
        const upload = (host: Host, samples: Float32Array, name: string = "tone.wav", chunk: number = 10000): void => {
            const nameBytes = new TextEncoder().encode(name)
            const begin = new DataView(new ArrayBuffer(20 + nameBytes.length))
            begin.setUint8(0, 6)
            begin.setUint32(4, samples.length, true)
            begin.setFloat64(8, RATE, true)
            begin.setUint32(16, nameBytes.length, true)
            new Uint8Array(begin.buffer).set(nameBytes, 20)
            host.bridges.receive(uuid, begin.buffer)
            for (let offset = 0; offset < samples.length; offset += chunk) {
                const count = Math.min(chunk, samples.length - offset)
                const message = new DataView(new ArrayBuffer(12 + count * 2))
                message.setUint8(0, 8)
                message.setUint32(4, offset, true)
                message.setUint32(8, count, true)
                for (let index = 0; index < count; index++) {
                    message.setInt16(12 + index * 2, Math.round(Math.max(-1, Math.min(32767 / 32768, samples[offset + index])) * 32768), true)
                }
                host.bridges.receive(uuid, message.buffer)
            }
            host.bridges.receive(uuid, new Uint8Array([9]).buffer)
        }
        const tone = (seconds: number = 1): Float32Array =>
            new Float32Array(RATE * seconds).map((_, index) => 0.8 * Math.sin(2 * Math.PI * 440 * index / RATE))
        const noise = (seconds: number = 1): Float32Array => {
            const state = {seed: 12345}
            return new Float32Array(RATE * seconds).map(() => {
                state.seed = (state.seed * 1103515245 + 12345) >>> 0
                return (state.seed / 4294967296) * 1.6 - 0.8
            })
        }
        const channels = (host: Host, handle: number, chunks: number): [number, number] => {
            const sums = [0, 0]
            for (let chunk = 0; chunk < chunks; chunk++) {
                process(host, handle)
                new Float32Array(host.memory.buffer, OUT0, 128).forEach(value => sums[0] += value * value)
                new Float32Array(host.memory.buffer, OUT1, 128).forEach(value => sums[1] += value * value)
            }
            return [Math.sqrt(sums[0] / (chunks * 128)), Math.sqrt(sums[1] / (chunks * 128))]
        }
        // first differences, a high-pass view of the left output
        const roughness = (host: Host, handle: number, chunks: number): number => {
            const state = {sum: 0, last: 0}
            for (let chunk = 0; chunk < chunks; chunk++) {
                process(host, handle)
                new Float32Array(host.memory.buffer, OUT0, 128).forEach(value => {
                    state.sum += (value - state.last) ** 2
                    state.last = value
                })
            }
            return Math.sqrt(state.sum / (chunks * 128))
        }
        const set = (host: Host, handle: number, name: string, value: number): void => {
            host.imports.host_wclap_param(handle, param(host, name).id | 0, FLOAT, value, NaN)
        }
        // status: type, grains, sample generation, mod generation, voices, then 42 values (float64),
        // 42 live normalized values (float32) and five floats per grain
        const status = (host: Host): { grains: number, sampleGeneration: number, voices: number, values: Array<number> } => {
            host.bridges.receive(uuid, new Uint8Array([1]).buffer)
            const view = new DataView(host.lastGui)
            expect(view.getUint8(0)).toBe(1)
            return {
                grains: view.getUint32(4, true), sampleGeneration: view.getUint32(8, true), voices: view.getUint32(16, true),
                values: Array.from({length: 42}, (_, index) => view.getFloat64(24 + index * 8, true))
            }
        }
        const peaks = (host: Host): { frames: number, rate: number, columns: number, name: string, bytes: Int8Array } => {
            const view = new DataView(host.lastGui)
            expect(view.getUint8(0)).toBe(2)
            const columns = view.getUint32(16, true)
            return {
                frames: view.getUint32(4, true), rate: view.getFloat64(8, true), columns,
                name: new TextDecoder().decode(new Uint8Array(host.lastGui, 28, view.getUint32(20, true))),
                bytes: new Int8Array(host.lastGui, 152, columns * 2)
            }
        }

        it("describes itself as an instrument that offers a device panel", async () => {
            const plugins = await createHost(xenonBundle).bridges.describe("xenon")
            expect(plugins.map(({clapId, name}) => [clapId, name])).toEqual([[XENON, "Xenon"]])
            expect(plugins[0].features).toEqual(expect.arrayContaining(["instrument", "synthesizer", "opendaw:device-panel"]))
        })

        it("is 512 wide in the device panel and opens a 1024 x 352 window, 1 to 3 times the panel", async () => {
            const [host] = await loadXenon()
            expect(host.statuses.at(-1)).toMatchObject({state: "ready", editor: true, panel: true})
            expect(host.bridges.openPanel(uuid, 176)).toEqual({uri: "/index.html", width: 512})
            expect(host.bridges.openGui(uuid)).toMatchObject({uri: "/index.html", width: 1024, height: 352, resizable: true})
            expect(host.bridges.resizeGui(uuid, 100, 100)).toEqual({width: 512, height: 176})
            expect(host.bridges.resizeGui(uuid, 4000, 4000)).toEqual({width: 1536, height: 528})
        })

        it("lists 42 parameters in the page's order with their defaults", async () => {
            const [host] = await loadXenon()
            expect(host.params.length).toBe(42)
            expect(host.params.slice(0, 5).map(({name, min, max, defaultValue}) => [name, min, max, defaultValue]))
                .toEqual([["Position", 0, 1, 0], ["Spray", 0, 1, 0.05], ["Scan", -2, 2, 0], ["Size", 1, 2000, 80], ["Density", 0.5, 200, 20]])
            expect(param(host, "Cutoff")).toMatchObject({min: 20, max: 20000, defaultValue: 20000})
            expect(param(host, "Env 2 Release")).toMatchObject({min: 1, max: 8000, defaultValue: 600})
        })

        it("stays silent without a sample, even with a note held", async () => {
            const [host, handle] = await loadXenon()
            host.imports.host_wclap_note(handle, 1, 60, 1)
            expect(rms(host, handle, 50)).toBe(0)
        })

        it("takes a sample from the page, answers with its peaks, plays grains while a note is held and stops after the release", async () => {
            const [host, handle] = await loadXenon()
            host.bridges.openPanel(uuid, 176)
            upload(host, tone(), "tone.wav")
            const answer = peaks(host)
            expect(answer).toMatchObject({frames: RATE, rate: RATE, columns: 2048, name: "tone.wav"})
            expect(Math.max(...answer.bytes)).toBeGreaterThan(95)
            expect(Math.min(...answer.bytes)).toBeLessThan(-95)
            expect(rms(host, handle, 10)).toBe(0)
            host.imports.host_wclap_note(handle, 1, 60, 1)
            expect(rms(host, handle, 100)).toBeGreaterThan(0.05)
            const playing = status(host)
            expect(playing.grains).toBeGreaterThan(0)
            expect(playing.voices).toBe(1)
            host.imports.host_wclap_note(handle, 0, 60, 0)
            rms(host, handle, 1500)
            expect(rms(host, handle, 10)).toBeLessThan(1e-4)
            expect(status(host)).toMatchObject({grains: 0, voices: 0})
        })

        it("plays a held note on and on, the countdown carries grains across blocks", async () => {
            const [host, handle] = await loadXenon()
            host.bridges.openPanel(uuid, 176)
            upload(host, tone())
            host.imports.host_wclap_note(handle, 1, 60, 1)
            const levels = Array.from({length: 10}, () => rms(host, handle, 100))
            levels.forEach(level => expect(level).toBeGreaterThan(0.05))
        })

        it("keeps at most 128 grains at once", async () => {
            const [host, handle] = await loadXenon()
            host.bridges.openPanel(uuid, 176)
            upload(host, tone())
            set(host, handle, "Density", 200)
            set(host, handle, "Size", 2000)
            host.imports.host_wclap_note(handle, 1, 60, 1)
            host.imports.host_wclap_note(handle, 1, 64, 1)
            host.imports.host_wclap_note(handle, 1, 67, 1)
            rms(host, handle, 800)
            // the status leaves out grains that start later in the block
            const {grains} = status(host)
            expect(grains).toBeGreaterThan(120)
            expect(grains).toBeLessThanOrEqual(128)
        })

        it("places grains at azimuth 90 to the right: the right ear louder and earlier than the left", async () => {
            const [host, handle] = await loadXenon()
            host.bridges.openPanel(uuid, 176)
            upload(host, tone())
            set(host, handle, "Azimuth", 90)
            set(host, handle, "Spread", 0)
            set(host, handle, "Room", 0)
            host.imports.host_wclap_note(handle, 1, 60, 1)
            const [left, right] = channels(host, handle, 200)
            expect(right).toBeGreaterThan(left * 1.5)
            set(host, handle, "Azimuth", -90)
            rms(host, handle, 100)
            const [leftAfter, rightAfter] = channels(host, handle, 200)
            expect(leftAfter).toBeGreaterThan(rightAfter * 1.5)
        })

        it("keeps grains in the centre equal on both ears (the room is not, it spreads)", async () => {
            const [host, handle] = await loadXenon()
            host.bridges.openPanel(uuid, 176)
            upload(host, tone())
            set(host, handle, "Spread", 0)
            set(host, handle, "Room", 0)
            host.imports.host_wclap_note(handle, 1, 60, 1)
            const [left, right] = channels(host, handle, 200)
            expect(left).toBeGreaterThan(0.05)
            expect(right).toBeCloseTo(left, 6)
        })

        it("filters every grain, a low cutoff takes the high content off noise", async () => {
            const measure = async (cutoff: number): Promise<number> => {
                const [host, handle] = await loadXenon()
                host.bridges.openPanel(uuid, 176)
                upload(host, noise())
                set(host, handle, "Cutoff", cutoff)
                set(host, handle, "Room", 0)
                host.imports.host_wclap_note(handle, 1, 60, 1)
                rms(host, handle, 20)
                return roughness(host, handle, 200)
            }
            const open = await measure(20000)
            const closed = await measure(200)
            expect(open).toBeGreaterThan(0.05)
            expect(closed).toBeLessThan(open * 0.1)
        })

        it("transposes grains by the note when key tracking is on, the peaks of a pitched tone stay where they are", async () => {
            const zeroCrossings = async (key: number, track: number): Promise<number> => {
                const [host, handle] = await loadXenon()
                host.bridges.openPanel(uuid, 176)
                upload(host, tone())
                set(host, handle, "Spread", 0)
                set(host, handle, "Room", 0)
                set(host, handle, "Size", 2000)
                set(host, handle, "Density", 1)
                set(host, handle, "Shape", 0.25)
                set(host, handle, "Key Track", track)
                host.imports.host_wclap_note(handle, 1, key, 1)
                rms(host, handle, 150)
                const state = {count: 0, last: 0}
                for (let chunk = 0; chunk < 100; chunk++) {
                    process(host, handle)
                    new Float32Array(host.memory.buffer, OUT0, 128).forEach(value => {
                        if ((value >= 0) !== (state.last >= 0)) {state.count++}
                        state.last = value
                    })
                }
                return state.count
            }
            const base = await zeroCrossings(60, 1)
            expect(base).toBeGreaterThan(200)
            expect(await zeroCrossings(72, 1) / base).toBeCloseTo(2, 1)
            expect(await zeroCrossings(72, 0) / base).toBeCloseTo(1, 1)
        })

        it("saves the parameters, the modulation and the sample, and a new instance plays the same", async () => {
            const [host, handle] = await loadXenon()
            host.bridges.openPanel(uuid, 176)
            upload(host, tone(0.5), "half.wav")
            const uploaded = Array.from(peaks(host).bytes)
            set(host, handle, "Size", 120)
            const mod = new DataView(new ArrayBuffer(16))
            mod.setUint8(0, 5)
            mod.setUint32(4, 0, true)
            mod.setUint32(8, 0, true)
            mod.setFloat32(12, 0.25, true)
            host.bridges.receive(uuid, mod.buffer)
            rms(host, handle, 2)
            host.bridges.saveState(uuid)
            const saved = host.states.at(-1)!
            // 16 header + 42 values + 42 x 10 depths + name + rate + frames + 16-bit frames
            expect(saved.length).toBe(16 + 42 * 8 + 42 * 10 * 4 + 4 + 8 + 8 + 4 + RATE)
            const other = createHost(xenonBundle)
            const otherHandle = load(other, XENON, "xenon")
            const base64 = Buffer.from(saved).toString("base64")
            new Uint8Array(other.memory.buffer).set(new TextEncoder().encode(base64), 2048)
            other.imports.host_wclap_state(otherHandle, 2048, base64.length)
            await ready(other, otherHandle)
            expect(param(other, "Size").value).toBeCloseTo(120, 9)
            other.bridges.openPanel(uuid, 176)
            other.bridges.receive(uuid, new Uint8Array([11]).buffer)
            expect(peaks(other)).toMatchObject({frames: RATE / 2, name: "half.wav"})
            expect(Array.from(peaks(other).bytes)).toEqual(uploaded)
            other.bridges.receive(uuid, new Uint8Array([12]).buffer)
            const mods = new DataView(other.lastGui)
            expect([mods.getUint8(0), mods.getUint32(4, true), mods.getUint32(8, true)]).toEqual([3, 10, 42])
            expect(mods.getFloat32(16, true)).toBeCloseTo(0.25, 6)
            other.imports.host_wclap_note(otherHandle, 1, 60, 1)
            expect(rms(other, otherHandle, 100)).toBeGreaterThan(0.05)
            // the bridge sends nothing for a state equal to the loaded one, so one value changes
            set(other, otherHandle, "Size", 121)
            rms(other, otherHandle, 1)
            other.bridges.saveState(uuid)
            const expected = saved.slice()
            new DataView(expected.buffer).setFloat64(16 + 3 * 8, 121, true)
            expect(Array.from(other.states.at(-1)!)).toEqual(Array.from(expected))
        })

        it("clears its sample from the page and from a state without one", async () => {
            const [host, handle] = await loadXenon()
            host.bridges.openPanel(uuid, 176)
            upload(host, tone())
            host.bridges.receive(uuid, new Uint8Array([10]).buffer)
            expect(peaks(host)).toMatchObject({frames: 0, columns: 0})
            host.imports.host_wclap_note(handle, 1, 60, 1)
            expect(rms(host, handle, 50)).toBe(0)
            host.bridges.saveState(uuid)
            expect(host.states.at(-1)!.length).toBe(16 + 42 * 8 + 42 * 10 * 4 + 4 + 8 + 4)
        })

        it("ignores a sample longer than 60 s and a chunk outside the announced frames", async () => {
            const [host] = await loadXenon()
            host.bridges.openPanel(uuid, 176)
            const begin = new DataView(new ArrayBuffer(20))
            begin.setUint8(0, 6)
            begin.setUint32(4, RATE * 61, true)
            begin.setFloat64(8, RATE, true)
            host.bridges.receive(uuid, begin.buffer)
            host.bridges.receive(uuid, new Uint8Array([9]).buffer)
            expect(status(host).sampleGeneration).toBe(0)
            begin.setUint32(4, 100, true)
            host.bridges.receive(uuid, begin.buffer)
            const chunk = new DataView(new ArrayBuffer(12 + 20))
            chunk.setUint8(0, 8)
            chunk.setUint32(4, 95, true)
            chunk.setUint32(8, 10, true)
            host.bridges.receive(uuid, chunk.buffer)
            host.bridges.receive(uuid, new Uint8Array([9]).buffer)
            expect(peaks(host)).toMatchObject({frames: 100})
        })

        it("takes a page edit as a host gesture and reports the value back in its status", async () => {
            const [host, handle] = await loadXenon()
            host.bridges.openPanel(uuid, 176)
            const edit = (type: number, value: number = 0): void => {
                const message = new DataView(new ArrayBuffer(type === 3 ? 16 : 8))
                message.setUint8(0, type)
                message.setUint32(4, 15, true)
                if (type === 3) {message.setFloat64(8, value, true)}
                host.bridges.receive(uuid, message.buffer)
            }
            host.reported.length = 0
            edit(2)
            edit(3, 1000)
            edit(4)
            rms(host, handle, 2)
            expect(host.reported).toEqual([[15, 0, 1], [15, 1000, 0], [15, 0, 2]])
            expect(status(host).values[15]).toBe(1000)
        })
    })
})
