import {Optional} from "@opendaw/lib-std"
import {CollabConfig} from "./types"

export class RoomService {
    readonly #config: CollabConfig
    readonly #shareBase: string

    constructor(config: CollabConfig) {
        this.#config = config
        this.#shareBase = config.shareBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : "http://localhost")
    }

    generateRoomId(): string {
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        const randomBytes = new Uint8Array(8)
        crypto.getRandomValues(randomBytes)
        let result = ""
        for (let i = 0; i < 8; i++) {result += chars[randomBytes[i] % chars.length]}
        return result
    }

    getShareUrl(roomId: string): string {
        return `${this.#shareBase}/r/${roomId}`
    }

    static parseShareUrl(url: string): Optional<string> {
        const match = url.match(/\/r\/([a-z0-9]+)$/)
        return match?.[1]
    }

    get endpoint(): string {
        return this.#config.endpoint
    }
}
