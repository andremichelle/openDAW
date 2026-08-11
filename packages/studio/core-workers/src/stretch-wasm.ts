// stretch_wasm: own-memory instance, empty imports, raw pointer/length ABI (crates/stretch-wasm).
// ONE cached instance per module url per realm: bpm detection and material analysis are the same
// binary, so a host that runs both compiles and holds it once.

export interface StretchExports {
    memory: WebAssembly.Memory
    alloc_bytes(len: number): number
    free_bytes(ptr: number, len: number): void
    detect_bpm(leftPtr: number, rightPtr: number, numFrames: number, sampleRate: number): number
    analyze(leftPtr: number, rightPtr: number, numFrames: number, sampleRate: number,
            outPtr: number, maxRecords: number): number
    record_size(): number
    analyzer_version(): number
}

const instances = new Map<string, Promise<StretchExports>>()

const instantiate = async (moduleUrl: string): Promise<StretchExports> => {
    const response = await fetch(moduleUrl)
    if (!response.ok) {
        return Promise.reject(new Error(`Could not load '${moduleUrl}' (${response.status} ${response.statusText})`))
    }
    const {instance} = await WebAssembly.instantiate(await response.arrayBuffer(), {})
    return instance.exports as unknown as StretchExports
}

export const stretchExports = (moduleUrl: string): Promise<StretchExports> => {
    const cached = instances.get(moduleUrl) ?? instantiate(moduleUrl)
    instances.set(moduleUrl, cached)
    return cached
}
