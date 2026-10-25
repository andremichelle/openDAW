// The WCLAP host bridge against the real Signalsmith Basics bundle (MIT, test/assets/basics.wclap.tar.gz):
// describe, load, audio, parameter mapping (ids above 2^31, unit/real kinds, folded modulation and its
// clearing), values queued before the plugin is up, state round trip, fault containment, load tracking.
// Audio port layouts against a minimal test plugin (test/assets/audio-ports.c).
// Device panel sessions, request_show and request_hide against the device-panel-demo (test/assets/device-panel.c).
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
    shows: Array<string>
    hovered: Array<number>
    hides: Array<string>
}

const createHost = (bundle: WclapBundle | (() => Promise<WclapBundle>) = basics): Host => {
    const memory = new WebAssembly.Memory({initial: 16})
    const host: Host = {
        bridges: undefined as unknown as WclapBridges, imports: {}, memory,
        statuses: [], params: [], states: [], reported: [], loads: [], saveRequests: 0, guiSends: 0, shows: [], hides: [], hovered: []
    }
    const callbacks: WclapHostCallbacks = {
        loadBundle: () => typeof bundle === "function" ? bundle() : Promise.resolve(bundle),
        sendGui: () => {host.guiSends++},
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
})
