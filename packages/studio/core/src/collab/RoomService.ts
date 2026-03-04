import {Optional} from "@opendaw/lib-std"
import {CollabConfig} from "./types"

const DEFAULT_SHARE_BASE = "https://opendaw.studio"

export class RoomService {
    readonly #config: CollabConfig
    readonly #shareBase: string

    constructor(config: CollabConfig) {
        this.#config = config
        this.#shareBase = config.shareBaseUrl ?? DEFAULT_SHARE_BASE
    }

    generateRoomId(): string {
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        let result = ""
        for (let i = 0; i < 8; i++) {result += chars[Math.floor(Math.random() * chars.length)]}
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
