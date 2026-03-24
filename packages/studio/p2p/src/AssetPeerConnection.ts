import {Terminable} from "@opendaw/lib-std"
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
    #channel: RTCDataChannel | null = null
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
                console.debug("[P2P:RTC] sending ICE candidate to", remotePeerId)
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
        await this.#connection.setRemoteDescription({type: "answer", sdp})
    }

    async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        await this.#connection.addIceCandidate(candidate)
    }

    async sendWithBackpressure(channel: RTCDataChannel, data: ArrayBuffer): Promise<void> {
        if (channel.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
            const {promise, resolve} = Promise.withResolvers<void>()
            channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW
            channel.onbufferedamountlow = () => {
                channel.onbufferedamountlow = null
                resolve()
            }
            await promise
        }
        channel.send(data)
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
