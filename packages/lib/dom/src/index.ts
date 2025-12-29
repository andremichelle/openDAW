const key = Symbol.for("@openDAW/lib-dom")

if ((globalThis as any)[key]) {
    console.debug(`%c${key.description}%c is already available in ${globalThis.constructor.name}.`, "color: hsl(10, 83%, 60%)", "color: inherit")
} else {
    (globalThis as any)[key] = true
    console.debug(`%c${key.description}%c is now available in ${globalThis.constructor.name}.`, "color: hsl(200, 83%, 60%)", "color: inherit")
}

export * from "./browser"
export * from "./compression"
export * from "./console-commands"
export * from "./constraint"
export * from "./context-2d"
export * from "./css-utils"
export * from "./dragging"
export * from "./events"
export * from "./files"
export * from "./fonts"
export * from "./frames"
export * from "./html"
export * from "./key"
export * from "./keyboard"
export * from "./modfier-keys"
export * from "./shortcut-definitions"
export * from "./shortcut-manager"
export * from "./stream"
export * from "./svg"
export * from "./tasks"
export * from "./terminable"