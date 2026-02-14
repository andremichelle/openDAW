// Polyfill for vitest
//
if (typeof globalThis.AudioWorkletNode === "undefined") {
    (globalThis as any).AudioWorkletNode = class AudioWorkletNode {}
}
if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>()
    Object.defineProperty(globalThis, "localStorage", {
        value: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => store.set(key, value),
            removeItem: (key: string) => store.delete(key),
            clear: () => store.clear(),
            get length() {return store.size},
            key: (index: number) => [...store.keys()][index] ?? null
        }
    })
}
