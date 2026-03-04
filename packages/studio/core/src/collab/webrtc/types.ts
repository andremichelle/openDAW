export type SignalMessage = {
    readonly fromIdentity: string
    readonly toIdentity: string
    readonly signalType: "offer" | "answer" | "ice"
    readonly payload: string
}

export type AssetRequest = {
    readonly type: "request"
    readonly assetId: string
}

export type AssetResponse = {
    readonly type: "response"
    readonly assetId: string
    readonly data: ArrayBuffer
}

export type AssetNotFound = {
    readonly type: "not-found"
    readonly assetId: string
}

export type DataChannelMessage = AssetRequest | AssetResponse | AssetNotFound
