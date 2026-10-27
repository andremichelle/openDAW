const key = Symbol.for("@openDAW/lib-box")

if ((globalThis as any)[key]) {
    console.debug(`%c${key.description}%c is already available in ${globalThis.constructor.name}.`, "color: hsl(10, 83%, 60%)", "color: inherit")
} else {
    (globalThis as any)[key] = true
    console.debug(`%c${key.description}%c is now available in ${globalThis.constructor.name}.`, "color: hsl(200, 83%, 60%)", "color: inherit")
}

export * from "./address"
export * from "./array"
export * from "./box"
export * from "./bytes-splice"
export * from "./constraints"
export * from "./dispatchers"
export * from "./editing"
export * from "./field"
export * from "./graph"
export * from "./graph-edges"
export * from "./indexed-box"
export * from "./object"
export * from "./pointer"
export * from "./pointer-hub"
export * from "./primitive"
export * from "./sync"
export * from "./sync-source"
export * from "./sync-target"
export * from "./updates"
export * from "./vertex"