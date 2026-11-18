import {assert} from "@opendaw/lib-std"

export namespace CustomServerFile {
    export const FileName = "opendaw.php"
    export const DefaultOrigins: ReadonlyArray<string> = ["https://opendaw.studio", "https://dev.opendaw.studio"]

    const OriginPattern = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/

    const toHex = (bytes: Uint8Array): string =>
        Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")

    const sha256Hex = async (text: string): Promise<string> =>
        toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))

    export const createToken = (): string => {
        const bytes = crypto.getRandomValues(new Uint8Array(32))
        return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
    }

    export const originsFor = (origin: string): ReadonlyArray<string> =>
        DefaultOrigins.includes(origin) ? DefaultOrigins : [...DefaultOrigins, origin]

    export const generate = async (template: string, token: string, origins: ReadonlyArray<string>): Promise<string> => {
        assert(token.length >= 32, "Token too short")
        origins.forEach(origin => assert(OriginPattern.test(origin), `Invalid origin: ${origin}`))
        const tokenHash = await sha256Hex(token)
        const dataFolder = `opendaw-data-${(await sha256Hex(`folder:${token}`)).substring(0, 32)}`
        return template
            .replace("'__TOKEN_HASH__'", `'${tokenHash}'`)
            .replace("'__ORIGINS__'", origins.map(origin => `'${origin}'`).join(", "))
            .replace("'__DATA_FOLDER__'", `'${dataFolder}'`)
    }
}
