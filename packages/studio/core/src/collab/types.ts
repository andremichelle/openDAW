export type CollabConfig = {
    readonly endpoint: string
    readonly shareBaseUrl?: string
    readonly databaseName?: string
}

export type RoomInfo = {
    readonly id: string
    readonly isPersistent: boolean
    readonly participantCount: number
}

export type Participant = {
    readonly identity: string
    readonly displayName: string
    readonly color: string
}

export type AssetMeta = {
    readonly assetId: string
    readonly name: string
    readonly sizeBytes: number
    readonly mimeType: string
}

export type PresenceData = {
    readonly identity: string
    readonly displayName: string
    readonly color: string
    readonly cursorX: number
    readonly cursorY: number
    readonly cursorTarget: string
}
