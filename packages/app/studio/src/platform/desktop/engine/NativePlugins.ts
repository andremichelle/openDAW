import {int, UUID} from "@opendaw/lib-std"

declare const __nativeCreate: (uuid: string) => int
declare const __nativeLoad: (handle: int, format: string, id: string) => void
declare const __nativeProcess: (handle: int, memory: ArrayBuffer, left: int, right: int, frames: int, bpm: number, position: number, flags: int) => int
declare const __nativeNote: (handle: int, on: int, key: int, velocity: number) => void
declare const __nativeState: (handle: int, state: ArrayBuffer) => void
declare const __nativeParam: (handle: int, id: int, kind: int, value: number, modulation: number) => void
declare const __nativeReset: (handle: int) => void
declare const __nativeRelease: (handle: int) => void
declare const __nativeOpenGui: (uuid: string) => void
declare const __nativeCloseGui: (uuid: string) => void
declare const __nativeSaveAll: () => void

export type NativePluginInfo = {
    format: string, id: string, name: string, vendor: string, kind: "instrument" | "effect" | "", path: string
    status: "ok" | "failed" | "incompatible" | "crashed"
}
export type NativeNotice = { uuid: string, type: "status" | "gui" | "saved" | "params" | "param" | "plugins", value: string }

export const NativeInstrumentBoxType = "NativeInstrumentBox"

export namespace NativePlugins {
    const decoder = new TextDecoder()
    const modules = new Map<string, Promise<WebAssembly.Module>>()

    export const deviceModule = (base: string): Promise<WebAssembly.Module> => {
        const url = `${base}/wasm/desktop/device_native_instrument.wasm`
        const loading = modules.get(url) ?? fetch(url)
            .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`${url}: ${response.status}`)))
            .then(bytes => WebAssembly.compile(bytes))
        modules.set(url, loading)
        return loading
    }

    // the device's host_native_* imports, bound to the engine memory
    export const imports = (memory: WebAssembly.Memory): Record<string, (...args: Array<number>) => number | void> => {
        const text = (pointer: int, length: int): string => decoder.decode(new Uint8Array(memory.buffer, pointer, length).slice())
        return {
            host_native_create: (uuidPtr: int): int =>
                __nativeCreate(UUID.toString(new Uint8Array(memory.buffer, uuidPtr, 16).slice() as UUID.Bytes)),
            host_native_load: (handle: int, formatPtr: int, formatLen: int, idPtr: int, idLen: int): void =>
                __nativeLoad(handle, text(formatPtr, formatLen), text(idPtr, idLen)),
            host_native_process: (handle: int, left: int, right: int, frames: int, bpm: number, position: number, flags: int): int =>
                __nativeProcess(handle, memory.buffer as ArrayBuffer, left, right, frames, bpm, position, flags),
            host_native_note: (handle: int, on: int, key: int, velocity: number): void => __nativeNote(handle, on, key, velocity),
            host_native_param: (handle: int, id: int, kind: int, value: number, modulation: number): void =>
                __nativeParam(handle, id >>> 0, kind, value, modulation),
            host_native_state: (handle: int, pointer: int, length: int): void =>
                __nativeState(handle, memory.buffer.slice(pointer, pointer + length) as ArrayBuffer),
            host_native_reset: (handle: int): void => __nativeReset(handle),
            host_native_release: (handle: int): void => __nativeRelease(handle)
        }
    }

    export const openGui = (uuid: string, open: boolean): void => open ? __nativeOpenGui(uuid) : __nativeCloseGui(uuid)

    export const saveAll = (): void => __nativeSaveAll()
}
