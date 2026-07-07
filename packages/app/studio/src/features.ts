import {asInstanceOf, EmptyExec, requireProperty} from "@opendaw/lib-std"

export const testFeatures = async (): Promise<void> => {
    requireProperty(Promise, "withResolvers")
    requireProperty(Array.prototype, "toSorted")
    requireProperty(window, "indexedDB")
    requireProperty(window, "AudioWorkletNode")
    requireProperty(window, "SharedArrayBuffer")
    requireProperty(navigator, "storage")
    requireProperty(navigator.storage, "getDirectory")
    requireProperty(crypto, "randomUUID")
    requireProperty(crypto, "subtle")
    requireProperty(crypto.subtle, "digest")
    if (!WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
    ]))) {throw new Error("WebAssembly SIMD is required")}
    asInstanceOf(new Audio().play(), Promise).catch(EmptyExec)
}