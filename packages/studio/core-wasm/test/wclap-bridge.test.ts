// The WCLAP host bridge against the real Signalsmith Basics bundle (MIT, test/assets/basics.wclap.tar.gz):
// describe, load, audio, parameter mapping (ids above 2^31, unit/real kinds, folded modulation and its
// clearing), values queued before the plugin is up, state round trip, fault containment, load tracking.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {gunzipSync} from "node:zlib"
import {WclapBundle, WclapBundleFile, WclapParamInfo, WclapStatus} from "@opendaw/studio-adapters"
import {WclapBridges, WclapHostCallbacks} from "../src/wclap/wclap-bridge"

const BASICS = path.resolve(__dirname, "assets", "basics.wclap.tar.gz")
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

type Host = {
    bridges: WclapBridges
    imports: Record<string, (...args: Array<number>) => number | void>
    memory: WebAssembly.Memory
    statuses: Array<WclapStatus>
    params: Array<WclapParamInfo>
    states: Array<Uint8Array>
    reported: Array<[number, number, number]>
    loads: Array<Promise<unknown>>
}

const createHost = (bundle: WclapBundle | (() => Promise<WclapBundle>) = basics): Host => {
    const memory = new WebAssembly.Memory({initial: 16})
    const host: Host = {
        bridges: undefined as unknown as WclapBridges, imports: {}, memory,
        statuses: [], params: [], states: [], reported: [], loads: []
    }
    const callbacks: WclapHostCallbacks = {
        loadBundle: () => typeof bundle === "function" ? bundle() : Promise.resolve(bundle),
        sendGui: () => {},
        sendState: (_uuid, bytes) => host.states.push(new Uint8Array(bytes)),
        sendParams: (_uuid, list) => {host.params = [...list]},
        sendParam: (_uuid, id, value, gesture) => host.reported.push([id, value, gesture]),
        sendHovered: () => {},
        sendStatus: (_uuid, status) => host.statuses.push(status),
        requestSave: () => {},
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
        expect(host.statuses.at(-1)).toEqual({state: "failed", message: "offline"})
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

    it("renders sub-quantum chunks", async () => {
        const host = createHost()
        const handle = load(host)
        await ready(host, handle)
        expect(process(host, handle, 1)).toBe(1)
        expect(process(host, handle, 37)).toBe(1)
    })
})
