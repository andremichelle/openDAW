// noinspection PlatformDetectionJS

import {isDefined, UUID} from "@moises-ai/lib-std"

export namespace Browser {
    const hasLocation = typeof self !== "undefined" && "location" in self && typeof self.location !== undefined
    const hasNavigator = typeof self !== "undefined" && "navigator" in self && typeof self.navigator !== undefined
    export const isLocalHost = () => hasLocation && location.host.includes("localhost")
    export const isMacOS = () => hasNavigator && navigator.userAgent.includes("Mac OS X")
    export const isWindows = () => hasNavigator && navigator.userAgent.includes("Windows")
    export const isChrome = () => hasNavigator && /chrome|chromium|crios/.test(navigator.userAgent.toLowerCase()) && !/edg|opera|opr/.test(navigator.userAgent.toLowerCase())
    export const isFirefox = () => hasNavigator && navigator.userAgent.toLowerCase().includes("firefox")
    export const isWeb = () => !isTauriApp()
    export const isVitest = typeof process !== "undefined" && process.env?.VITEST === "true"
    export const isTauriApp = () => "__TAURI__" in window
    export const userAgent = hasNavigator ? navigator.userAgent
        .replace(/^Mozilla\/[\d.]+\s*/, "")
        .replace(/\bAppleWebKit\/[\d.]+\s*/g, "")
        .replace(/\(KHTML, like Gecko\)\s*/g, "")
        .replace(/\bSafari\/[\d.]+\s*/g, "")
        .replace(/\s+/g, " ")
        .trim() : "N/A"
    export const id = () => {
        if (!hasLocation) {return ""}
        const key = "__id__"
        const id = localStorage.getItem(key)
        if (isDefined(id)) {return id}
        const newID = UUID.toString(UUID.generate())
        localStorage.setItem(key, newID)
        return newID
    }
}