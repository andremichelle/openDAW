import {Nullable} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {isObject} from "@/call/CallTypes"

export type FollowRequest = {
    readonly type: "request"
    readonly from: number
    readonly to: number
    readonly nonce: number
}

export type FollowState = {
    readonly type: "state"
    readonly from: number
    readonly to: number
    readonly nonce: number
    readonly playing: boolean
    readonly position: ppqn
    readonly outputLatency: number
    readonly sentAt: number
}

export type FollowTransport = {
    readonly type: "transport"
    readonly from: number
    readonly playing: boolean
    readonly position: ppqn
    readonly outputLatency: number
    readonly sentAt: number
}

export type FollowMessage = FollowRequest | FollowState | FollowTransport

export type FollowTransportEvent = {
    readonly playing: boolean
    readonly position: ppqn
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

const isClientId = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value)

export const asFollowTarget = (value: unknown): Nullable<number> => isClientId(value) ? value : null

export const asFollowMessage = (value: unknown): Nullable<FollowMessage> => {
    if (!isObject(value) || !isClientId(value.from)) {return null}
    const from = value.from
    switch (value.type) {
        case "request":
            return isClientId(value.to) && isFiniteNumber(value.nonce)
                ? {type: "request", from, to: value.to, nonce: value.nonce} : null
        case "state":
            return isClientId(value.to) && isFiniteNumber(value.nonce) && typeof value.playing === "boolean"
            && isFiniteNumber(value.position) && isFiniteNumber(value.outputLatency) && isFiniteNumber(value.sentAt)
                ? {
                    type: "state", from, to: value.to, nonce: value.nonce, playing: value.playing,
                    position: value.position, outputLatency: value.outputLatency, sentAt: value.sentAt
                } : null
        case "transport":
            return typeof value.playing === "boolean" && isFiniteNumber(value.position)
            && isFiniteNumber(value.outputLatency) && isFiniteNumber(value.sentAt)
                ? {
                    type: "transport", from, playing: value.playing, position: value.position,
                    outputLatency: value.outputLatency, sentAt: value.sentAt
                } : null
        default:
            return null
    }
}

export const isAddressedTo = (message: FollowMessage, clientId: number): boolean =>
    message.type === "transport" || message.to === clientId
