import {isDefined, Nullable} from "@opendaw/lib-std"

export type CallPresence = {
    readonly peerId: string
    readonly mic: boolean
    readonly camera: boolean
    readonly screen: boolean
    readonly hand: boolean
    readonly music: boolean
    readonly screenStreamId: string
    readonly joinedAt: number
}

export type CallParticipant = {
    readonly peerId: string
    readonly clientId: number
    readonly name: string
    readonly color: string
    readonly self: boolean
    readonly presence: CallPresence
}

export type CallDescriptionSignal = {
    readonly type: "description"
    readonly peerId: string
    readonly targetPeerId: string
    readonly description: RTCSessionDescriptionInit
}

export type CallCandidateSignal = {
    readonly type: "candidate"
    readonly peerId: string
    readonly targetPeerId: string
    readonly candidate: RTCIceCandidateInit
}

export type CallByeSignal = {
    readonly type: "bye"
    readonly peerId: string
}

export type CallSignal = CallDescriptionSignal | CallCandidateSignal | CallByeSignal

export type CallQuality = {
    readonly rtt: number
    readonly loss: number
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && isDefined(value)

export const asCallPresence = (value: unknown): Nullable<CallPresence> => {
    if (!isObject(value) || typeof value.peerId !== "string") {return null}
    return {
        peerId: value.peerId,
        mic: value.mic === true,
        camera: value.camera === true,
        screen: value.screen === true,
        hand: value.hand === true,
        music: value.music === true,
        screenStreamId: typeof value.screenStreamId === "string" ? value.screenStreamId : "",
        joinedAt: typeof value.joinedAt === "number" ? value.joinedAt : 0
    }
}

export const asCallSignal = (value: unknown): Nullable<CallSignal> => {
    if (!isObject(value) || typeof value.peerId !== "string") {return null}
    const peerId = value.peerId
    switch (value.type) {
        case "description":
            return typeof value.targetPeerId === "string" && isObject(value.description)
                && (value.description.type === "offer" || value.description.type === "answer")
                && typeof value.description.sdp === "string"
                ? {
                    type: "description", peerId, targetPeerId: value.targetPeerId,
                    description: {type: value.description.type, sdp: value.description.sdp}
                } : null
        case "candidate":
            return typeof value.targetPeerId === "string" && isObject(value.candidate)
            && typeof value.candidate.candidate === "string"
                ? {
                    type: "candidate", peerId, targetPeerId: value.targetPeerId, candidate: {
                        candidate: value.candidate.candidate,
                        sdpMid: typeof value.candidate.sdpMid === "string" ? value.candidate.sdpMid : null,
                        sdpMLineIndex: typeof value.candidate.sdpMLineIndex === "number"
                            ? value.candidate.sdpMLineIndex : null,
                        usernameFragment: typeof value.candidate.usernameFragment === "string"
                            ? value.candidate.usernameFragment : null
                    }
                } : null
        case "bye":
            return {type: "bye", peerId}
        default:
            return null
    }
}

export const isTargeted = (signal: CallSignal, localPeerId: string): boolean =>
    signal.type === "description" || signal.type === "candidate" ? signal.targetPeerId === localPeerId : true

export const hasLiveVideo = (stream: Nullable<MediaStream>): boolean =>
    isDefined(stream) && stream.getVideoTracks().some(track => track.readyState === "live")
