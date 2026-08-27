const key = Symbol.for("@openDAW/opendaw-scripting")

if ((globalThis as any)[key]) {
    console.debug(`%c${key.description}%c is already available in ${globalThis.constructor.name}.`, "color: hsl(10, 83%, 60%)", "color: inherit")
} else {
    (globalThis as any)[key] = true
    console.debug(`%c${key.description}%c is now available in ${globalThis.constructor.name}.`, "color: hsl(200, 83%, 60%)", "color: inherit")
}

export * from "./Api"
export * from "./impl/index"
export * from "./ScriptExecutionProtocol"
export * from "./ScriptRunner"
export * from "./ScriptHost"
export * from "./ScriptHostProtocol"
