import {isDefined, Notifier, Optional, Terminable, Terminator} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {CollabConfig, PresenceData} from "./types"
import {RoomService} from "./RoomService"
import {PresenceService} from "./PresenceService"
import {PeerManager} from "./webrtc/PeerManager"
import {AssetSource, AssetTransportChain} from "./assets/AssetTransport"
import {OpfsAssetSource} from "./assets/OpfsAssetSource"
import {WebRTCAssetSource} from "./assets/WebRTCAssetSource"
import {StdbConnection, StdbConnectionState} from "./stdb/StdbConnection"
import {BoxStateRow, StdbSync} from "./StdbSync"

export enum CollabState {
    Disconnected = "disconnected",
    Connecting = "connecting",
    Connected = "connected",
}

type SdkDb = {
    room: {
        onInsert(cb: (ctx: unknown, row: RoomRow) => void): void
    }
    presence: {
        onInsert(cb: (ctx: unknown, row: PresenceRow) => void): void
        onDelete(cb: (ctx: unknown, row: PresenceRow) => void): void
        onUpdate(cb: (ctx: unknown, oldRow: PresenceRow, newRow: PresenceRow) => void): void
    }
    room_participant: {
        onInsert(cb: (ctx: unknown, row: ParticipantRow) => void): void
        onDelete(cb: (ctx: unknown, row: ParticipantRow) => void): void
    }
    box_state: {
        onInsert(cb: (ctx: unknown, row: BoxStateRow) => void): void
        onUpdate(cb: (ctx: unknown, oldRow: BoxStateRow, newRow: BoxStateRow) => void): void
        onDelete(cb: (ctx: unknown, row: BoxStateRow) => void): void
        iter(): Iterable<BoxStateRow>
    }
}

type RoomRow = {
    readonly id: string
    readonly creatorIdentity: {toHexString?: () => string}
}

type PresenceRow = {
    readonly identity: {toHexString?: () => string}
    readonly roomId: string
    readonly displayName: string
    readonly color: string
    readonly cursorX: number
    readonly cursorY: number
    readonly cursorTarget: string
}

type ParticipantRow = {
    readonly identity: {toHexString?: () => string}
    readonly roomId: string
    readonly displayName: string
    readonly color: string
}

type SdkConnection = {
    db: SdkDb
    reducers: {
        createRoom(params: Record<string, never>): void
        joinRoom(params: {roomId: string, displayName: string}): void
        leaveRoom(params: {roomId: string}): void
        updatePresence(params: {roomId: string, cursorX: number, cursorY: number, cursorTarget: string}): void
        boxCreate(params: {roomId: string, boxUuid: string, boxName: string, data: string}): void
        boxUpdate(params: {roomId: string, boxUuid: string, data: string}): void
        boxDelete(params: {roomId: string, boxUuid: string}): void
    }
    subscriptionBuilder(): {
        onApplied(cb: (ctx: unknown) => void): {
            onError(cb: (ctx: unknown, err: unknown) => void): {
                subscribe(queries: Array<string>): unknown
            }
        }
    }
}

export class CollabService implements Terminable {
    readonly #terminator = new Terminator()
    readonly #config: CollabConfig
    readonly room: RoomService
    readonly presence: PresenceService
    readonly peerManager: PeerManager
    readonly assets: AssetTransportChain
    readonly connection: StdbConnection
    readonly onChange: Notifier<CollabState> = new Notifier()
    #state: CollabState = CollabState.Disconnected
    #roomId: Optional<string> = undefined
    #displayName: Optional<string> = undefined
    #isCreating = false
    #pendingRoomResolve: Optional<(roomId: string) => void> = undefined
    #pendingRoomReject: Optional<(reason: Error) => void> = undefined
    #boxGraph: Optional<BoxGraph<any>> = undefined
    #stdbSync: Optional<StdbSync<any>> = undefined

    constructor(config: CollabConfig) {
        this.#config = config
        this.room = new RoomService(config)
        this.presence = new PresenceService()
        this.peerManager = new PeerManager()
        const sources: Array<AssetSource> = [new OpfsAssetSource()]
        sources.push(new WebRTCAssetSource(this.peerManager))
        this.assets = new AssetTransportChain(sources)
        this.connection = new StdbConnection({
            endpoint: config.endpoint,
            databaseName: config.databaseName ?? "opendaw",
        })
        this.#terminator.own(this.presence)
        this.#terminator.own(this.peerManager)
        this.#terminator.own(this.connection)
        this.#terminator.own(this.connection.onChange.subscribe(connectionState => {
            console.debug("[CollabService] connection state changed:", connectionState)
            if (connectionState === StdbConnectionState.Connected && this.#state === CollabState.Connecting) {
                this.#setupSubscriptions()
            } else if (connectionState === StdbConnectionState.Disconnected && this.#state !== CollabState.Disconnected) {
                if (isDefined(this.#stdbSync)) {
                    this.#stdbSync.terminate()
                    this.#stdbSync = undefined
                }
                this.#boxGraph = undefined
                this.#roomId = undefined
                this.#isCreating = false
                this.#pendingRoomResolve = undefined
                this.#pendingRoomReject = undefined
                this.presence.clear()
                this.#setState(CollabState.Disconnected)
            }
        }))
    }

    get state(): CollabState {return this.#state}
    get roomId(): Optional<string> {return this.#roomId}
    get displayName(): Optional<string> {return this.#displayName}

    createRoom(displayName?: string, boxGraph?: BoxGraph<any>): Promise<string> {
        this.#displayName = displayName ?? this.#getStoredDisplayName()
        this.#boxGraph = boxGraph
        this.#isCreating = true
        this.#setState(CollabState.Connecting)
        this.connection.connect()
        return new Promise<string>((resolve, reject) => {
            this.#pendingRoomResolve = resolve
            this.#pendingRoomReject = reject
        })
    }

    joinRoom(roomId: string, displayName?: string, boxGraph?: BoxGraph<any>): void {
        this.#roomId = roomId
        this.#displayName = displayName ?? this.#getStoredDisplayName()
        this.#boxGraph = boxGraph
        this.#isCreating = false
        this.#setState(CollabState.Connecting)
        this.connection.connect()
    }

    leaveRoom(): void {
        const conn = this.connection.sdk as Optional<SdkConnection>
        const roomId = this.#roomId
        if (isDefined(conn) && isDefined(roomId)) {
            try {conn.reducers.leaveRoom({roomId})} catch (error: unknown) {
                console.error("[CollabService] leaveRoom reducer error:", error)
            }
        }
        if (isDefined(this.#stdbSync)) {
            this.#stdbSync.terminate()
            this.#stdbSync = undefined
        }
        this.#boxGraph = undefined
        this.#roomId = undefined
        this.#isCreating = false
        this.#pendingRoomResolve = undefined
        this.#pendingRoomReject = undefined
        this.#setState(CollabState.Disconnected)
        this.connection.disconnect()
        this.presence.clear()
    }

    updateCursor(cursorX: number, cursorY: number, cursorTarget: string): void {
        if (this.#state !== CollabState.Connected) {return}
        const conn = this.connection.sdk as Optional<SdkConnection>
        const roomId = this.#roomId
        if (!isDefined(conn) || !isDefined(roomId)) {return}
        try {conn.reducers.updatePresence({roomId, cursorX, cursorY, cursorTarget})} catch (error: unknown) {
            console.debug("[CollabService] updatePresence reducer error:", error)
        }
    }

    terminate(): void {
        if (isDefined(this.#stdbSync)) {
            this.#stdbSync.terminate()
            this.#stdbSync = undefined
        }
        this.#boxGraph = undefined
        this.#roomId = undefined
        this.#isCreating = false
        this.#pendingRoomResolve = undefined
        this.#pendingRoomReject = undefined
        this.#state = CollabState.Disconnected
        this.#terminator.terminate()
        this.onChange.terminate()
    }

    #setState(state: CollabState): void {
        this.#state = state
        this.onChange.notify(state)
    }

    #getStoredDisplayName(): string {
        try {
            return globalThis.localStorage?.getItem("opendaw-display-name") ?? "Anonymous"
        } catch {
            return "Anonymous"
        }
    }

    #identityHex(identity: {toHexString?: () => string}): string {
        return typeof identity?.toHexString === "function"
            ? identity.toHexString()
            : String(identity)
    }

    #presenceFromRow(row: PresenceRow): PresenceData {
        return {
            identity: this.#identityHex(row.identity),
            displayName: row.displayName,
            color: row.color,
            cursorX: row.cursorX,
            cursorY: row.cursorY,
            cursorTarget: row.cursorTarget,
        }
    }

    #setupSubscriptions(): void {
        const conn = this.connection.sdk as Optional<SdkConnection>
        const selfIdentity = this.connection.identity
        if (!isDefined(conn)) {
            console.debug("[CollabService] SDK not available, entering connected state without subscriptions")
            if (this.#isCreating) {
                const roomId = this.#roomId ?? this.room.generateRoomId()
                this.#roomId = roomId
                this.#isCreating = false
                if (isDefined(this.#pendingRoomResolve)) {
                    this.#pendingRoomResolve(roomId)
                    this.#pendingRoomResolve = undefined
                    this.#pendingRoomReject = undefined
                }
            }
            this.#setState(CollabState.Connected)
            return
        }
        if (this.#isCreating) {
            this.#setupAsHost(conn, selfIdentity)
        } else if (isDefined(this.#roomId)) {
            this.#joinAndSubscribe(conn, this.#roomId, selfIdentity, false)
        }
    }

    #setupAsHost(conn: SdkConnection, selfIdentity: Optional<string>): void {
        let reducerCalled = false
        conn.db.room.onInsert((_ctx: unknown, row: RoomRow) => {
            console.debug("[CollabService] room.onInsert:", row.id)
            if (!reducerCalled) {return}
            const rowCreator = this.#identityHex(row.creatorIdentity)
            if (rowCreator !== selfIdentity) {return}
            this.#roomId = row.id
            const wasCreating = this.#isCreating
            this.#isCreating = false
            if (isDefined(this.#pendingRoomResolve)) {
                this.#pendingRoomResolve(row.id)
                this.#pendingRoomResolve = undefined
            }
            this.#joinAndSubscribe(conn, row.id, selfIdentity, wasCreating)
        })
        conn.subscriptionBuilder()
            .onApplied((_ctx: unknown) => {
                reducerCalled = true
                console.debug("[CollabService] room subscription onApplied, calling createRoom")
                try {conn.reducers.createRoom({} as Record<string, never>)} catch (error: unknown) {
                    console.error("[CollabService] createRoom reducer error:", error)
                }
            })
            .onError((_ctx: unknown, err: unknown) => {
                console.error("[CollabService] room subscription error:", err)
            })
            .subscribe(["SELECT * FROM room"])
    }

    #joinAndSubscribe(conn: SdkConnection, roomId: string, selfIdentity: Optional<string>, isHost: boolean): void {
        console.debug("[CollabService] #joinAndSubscribe called with roomId:", roomId)
        const name = this.#displayName ?? "Anonymous"
        conn.db.presence.onInsert((_ctx: unknown, row: PresenceRow) => {
            if (row.roomId !== roomId) {return}
            const rowIdentity = this.#identityHex(row.identity)
            if (rowIdentity === selfIdentity) {return}
            this.presence.updatePresence(this.#presenceFromRow(row))
        })
        conn.db.presence.onUpdate((_ctx: unknown, _oldRow: PresenceRow, newRow: PresenceRow) => {
            if (newRow.roomId !== roomId) {return}
            const rowIdentity = this.#identityHex(newRow.identity)
            if (rowIdentity === selfIdentity) {return}
            this.presence.updatePresence(this.#presenceFromRow(newRow))
        })
        conn.db.presence.onDelete((_ctx: unknown, row: PresenceRow) => {
            if (row.roomId !== roomId) {return}
            this.presence.removeParticipant(this.#identityHex(row.identity))
        })
        conn.db.room_participant.onInsert((_ctx: unknown, row: ParticipantRow) => {
            if (row.roomId !== roomId) {return}
            const rowIdentity = this.#identityHex(row.identity)
            if (rowIdentity === selfIdentity) {return}
            if (this.presence.participants.some(participant => participant.identity === rowIdentity)) {return}
            this.presence.updatePresence({
                identity: rowIdentity,
                displayName: row.displayName,
                color: row.color,
                cursorX: 0,
                cursorY: 0,
                cursorTarget: "",
            })
        })
        conn.db.room_participant.onDelete((_ctx: unknown, row: ParticipantRow) => {
            if (row.roomId !== roomId) {return}
            this.presence.removeParticipant(this.#identityHex(row.identity))
        })
        conn.subscriptionBuilder()
            .onApplied((_ctx: unknown) => {
                console.debug("[CollabService] presence subscription onApplied, joining room")
                try {conn.reducers.joinRoom({roomId, displayName: name})} catch (error: unknown) {
                    console.error("[CollabService] joinRoom reducer error:", error)
                }
                this.#scanExistingPresence(conn, roomId, selfIdentity)
                this.#initBoxSync(conn, roomId, isHost)
                this.#setState(CollabState.Connected)
            })
            .onError((_ctx: unknown, err: unknown) => {
                console.error("[CollabService] presence subscription error:", err)
            })
            .subscribe([
                "SELECT * FROM presence WHERE room_id = ?",
                "SELECT * FROM room_participant WHERE room_id = ?",
                "SELECT * FROM box_state WHERE room_id = ?",
            ].map(query => query.replace("?", `'${roomId.replace(/'/g, "''")}'`)))
    }

    #initBoxSync(conn: SdkConnection, roomId: string, isHost: boolean): void {
        if (!isDefined(this.#boxGraph)) {return}
        try {
            if (isHost) {
                this.#stdbSync = StdbSync.populateRoom(this.#boxGraph, conn, roomId)
            } else {
                const db = conn.db as SdkDb & {box_state: {iter(): Iterable<BoxStateRow>}}
                const rows = Array.from(db.box_state.iter()).filter(row => row.roomId === roomId)
                this.#stdbSync = StdbSync.joinRoom(this.#boxGraph, conn, roomId, rows)
            }
            console.debug("[CollabService] box sync initialized, isHost:", isHost)
        } catch (error: unknown) {
            console.error("[CollabService] box sync init error:", error)
        }
    }

    #scanExistingPresence(conn: SdkConnection, roomId: string, selfIdentity: Optional<string>): void {
        try {
            const db = conn.db as SdkDb & {
                presence: {iter(): Iterable<PresenceRow>}
                room_participant: {iter(): Iterable<ParticipantRow>}
            }
            for (const row of db.presence.iter()) {
                if (row.roomId !== roomId) {continue}
                const rowIdentity = this.#identityHex(row.identity)
                if (rowIdentity === selfIdentity) {continue}
                this.presence.updatePresence(this.#presenceFromRow(row))
            }
            for (const row of db.room_participant.iter()) {
                if (row.roomId !== roomId) {continue}
                const rowIdentity = this.#identityHex(row.identity)
                if (rowIdentity === selfIdentity) {continue}
                if (this.presence.participants.some(participant => participant.identity === rowIdentity)) {continue}
                this.presence.updatePresence({
                    identity: rowIdentity,
                    displayName: row.displayName,
                    color: row.color,
                    cursorX: 0,
                    cursorY: 0,
                    cursorTarget: "",
                })
            }
        } catch (error: unknown) {
            console.debug("[CollabService] scanExistingPresence error:", error)
        }
    }
}
