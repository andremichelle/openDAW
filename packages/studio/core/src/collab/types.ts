import {Optional} from "@opendaw/lib-std"

export type CollabConfig = {
    readonly endpoint: string
    readonly shareBaseUrl?: string
    readonly s3?: S3Config
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
    readonly s3Url: Optional<string>
}

export type PresenceData = {
    readonly identity: string
    readonly displayName: string
    readonly color: string
    readonly cursorX: number
    readonly cursorY: number
    readonly cursorTarget: string
}

export type S3Config = {
    readonly bucket: string
    readonly region: string
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly endpoint?: string
}
