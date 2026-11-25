import {asInstanceOf, EmptyExec, requireProperty} from "@opendaw/lib-std"

export const testFeatures = async (): Promise<void> => {
    requireProperty(Promise, "withResolvers")
    requireProperty(Array.prototype, "toSorted")
    requireProperty(window, "indexedDB")
    requireProperty(window, "WebAssembly")
    requireProperty(window, "AudioWorkletNode")
    requireProperty(window, "SharedArrayBuffer")
    // a privacy setting can remove it, every canvas reads it (errors 1182, 1183)
    requireProperty(window, "devicePixelRatio")
    requireProperty(navigator, "storage")
    requireProperty(navigator.storage, "getDirectory")
    requireProperty(crypto, "randomUUID")
    requireProperty(crypto, "subtle")
    requireProperty(crypto.subtle, "digest")
    if (!WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
    ]))) {throw new Error("Your computer's processor (CPU) is too old to run openDAW. Most computers from 2011 or later will work.")}
    asInstanceOf(new Audio().play(), Promise).catch(EmptyExec)
}