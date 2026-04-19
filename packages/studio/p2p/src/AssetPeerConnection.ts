import {Nullable, Terminable} from "@opendaw/lib-std"
import {AssetSignaling} from "./AssetSignaling"

const RTC_CONFIG: RTCConfiguration = {
    iceServers: [
        {urls: "stun:stun.l.google.com:19302"},
        {urls: "turn:live.opendaw.studio:3478", username: "opendaw", credential: "opendaw"}
    ]
}

const BUFFERED_AMOUNT_HIGH = 1_048_576
const BUFFERED_AMOUNT_LOW = 262_144

export class AssetPeerConnection implements Terminable {
    readonly #connection: RTCPeerConnection
    readonly #signaling: AssetSignaling
    readonly #localPeerId: string
    readonly #remotePeerId: string
    readonly #pendingCandidates: Array<RTCIceCandidateInit> = []

    #remoteDescriptionSet: boolean = false
    #channel: Nullable<RTCDataChannel> = null
    #terminated: boolean = false

    constructor(signaling: AssetSignaling, localPeerId: string, remotePeerId: string) {
        this.#signaling = signaling
        this.#localPeerId = localPeerId
        this.#remotePeerId = remotePeerId
        this.#connection = new RTCPeerConnection(RTC_CONFIG)
        this.#connection.oniceconnectionstatechange = () => {
            console.debug("[P2P:RTC]", localPeerId, "→", remotePeerId, "ICE:", this.#connection.iceConnectionState)
        }
        this.#connection.onconnectionstatechange = () => {
            console.debug("[P2P:RTC]", localPeerId, "→", remotePeerId, "connection:", this.#connection.connectionState)
        }
        this.#connection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
            if (event.candidate !== null) {
                this.#signaling.publish({
                    type: "rtc-ice-candidate",
                    peerId: this.#localPeerId,
                    targetPeerId: this.#remotePeerId,
                    candidate: event.candidate.toJSON()
                })
            }
        }
    }

    get channel(): RTCDataChannel | null {return this.#channel}

    async createOffer(): Promise<RTCDataChannel> {
        const channel = this.#connection.createDataChannel("assets", {ordered: true})
        channel.binaryType = "arraybuffer"
        this.#channel = channel
        const offer = await this.#connection.createOffer()
        await this.#connection.setLocalDescription(offer)
        this.#signaling.publish({
            type: "rtc-offer",
            peerId: this.#localPeerId,
            targetPeerId: this.#remotePeerId,
            sdp: offer.sdp!
        })
        return channel
    }

    async handleOffer(sdp: string): Promise<RTCDataChannel> {
        const {promise, resolve} = Promise.withResolvers<RTCDataChannel>()
        this.#connection.ondatachannel = (event: RTCDataChannelEvent) => {
            event.channel.binaryType = "arraybuffer"
            this.#channel = event.channel
            resolve(event.channel)
        }
        await this.#connection.setRemoteDescription({type: "offer", sdp})
        this.#remoteDescriptionSet = true
        await this.#drainPendingCandidates()
        const answer = await this.#connection.createAnswer()
        await this.#connection.setLocalDescription(answer)
        this.#signaling.publish({
            type: "rtc-answer",
            peerId: this.#localPeerId,
            targetPeerId: this.#remotePeerId,
            sdp: answer.sdp!
        })
        return promise
    }

    async handleAnswer(sdp: string): Promise<void> {
        if (this.#remoteDescriptionSet) {return}
        await this.#connection.setRemoteDescription({type: "answer", sdp})
        this.#remoteDescriptionSet = true
        await this.#drainPendingCandidates()
    }

    async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        if (this.#remoteDescriptionSet) {
            await this.#connection.addIceCandidate(candidate)
        } else {
            this.#pendingCandidates.push(candidate)
        }
    }

    async sendWithBackpressure(channel: RTCDataChannel, data: ArrayBuffer): Promise<boolean> {
        if (channel.readyState !== "open") {return false}
        if (channel.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
            const {promise, resolve} = Promise.withResolvers<void>()
            channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW
            const onClose = () => resolve()
            const onError = () => resolve()
            channel.onbufferedamountlow = () => resolve()
            channel.addEventListener("close", onClose, {once: true})
            channel.addEventListener("error", onError, {once: true})
            await promise
            channel.onbufferedamountlow = null
            channel.removeEventListener("close", onClose)
            channel.removeEventListener("error", onError)
            if (channel.readyState !== "open") {return false}
        }
        channel.send(data)
        return true
    }

    async #drainPendingCandidates(): Promise<void> {
        for (const candidate of this.#pendingCandidates) {
            await this.#connection.addIceCandidate(candidate)
        }
        this.#pendingCandidates.length = 0
    }

    terminate(): void {
        if (this.#terminated) {return}
        this.#terminated = true
        if (this.#channel !== null) {
            this.#channel.close()
        }
        this.#connection.close()
    }
}
