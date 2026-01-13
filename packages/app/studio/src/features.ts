import {requireProperty} from "@moises-ai/lib-std"

export const testFeatures = async (): Promise<void> => {
    requireProperty(Promise, "withResolvers")
    requireProperty(window, "indexedDB")
    requireProperty(window, "AudioWorkletNode")
    requireProperty(navigator, "storage")
    requireProperty(navigator.storage, "getDirectory")
    requireProperty(crypto, "randomUUID")
    requireProperty(crypto, "subtle")
    requireProperty(crypto.subtle, "digest")
}