import {UUID} from "@opendaw/lib-std"

export type RoomResultStatus = "success" | "sync_timeout" | "socket_error" | "abort" | "unknown"

const ENDPOINT = "https://api.opendaw.studio/rooms/room-counter.php"

export const newRoomSessionId = (): string => UUID.toString(UUID.generate())

export const reportRoomResult = (sessionId: string, status: RoomResultStatus): void => {
    void fetch(ENDPOINT, {
        method: "POST",
        mode: "cors",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({action: "result", sessionId, status})
    }).catch(() => {})
}

export const reportRoomDuration = (sessionId: string, durationMinutes: number): void => {
    if (durationMinutes <= 0) {return}
    const body = JSON.stringify({action: "ended", sessionId, durationMinutes})
    if (typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(ENDPOINT, new Blob([body], {type: "application/json"}))
        return
    }
    void fetch(ENDPOINT, {
        method: "POST",
        mode: "cors",
        headers: {"Content-Type": "application/json"},
        body,
        keepalive: true
    }).catch(() => {})
}

const HEARTBEAT_MS = 60_000

export type RoomDurationHeartbeat = { finalize: () => void }

export const startRoomDurationHeartbeat = (sessionId: string): RoomDurationHeartbeat => {
    let lastTickAt = Date.now()
    let finalized = false
    const interval = setInterval(() => {
        reportRoomDuration(sessionId, 1)
        lastTickAt = Date.now()
    }, HEARTBEAT_MS)
    return {
        finalize: () => {
            if (finalized) {return}
            finalized = true
            clearInterval(interval)
            const trailing = Math.round((Date.now() - lastTickAt) / 60_000)
            if (trailing > 0) {reportRoomDuration(sessionId, trailing)}
        }
    }
}
