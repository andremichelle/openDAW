import {isDefined, Notifier, Terminable} from "@opendaw/lib-std"
import {PeerManager} from "./PeerManager"
import {SignalMessage} from "./types"

export class SignalingService implements Terminable {
    readonly #localIdentity: string
    readonly #peerManager: PeerManager
    readonly onOutgoingSignal: Notifier<SignalMessage> = new Notifier()

    constructor(localIdentity: string, peerManager: PeerManager) {
        this.#localIdentity = localIdentity
        this.#peerManager = peerManager
    }

    get localIdentity(): string {return this.#localIdentity}

    sendOffer(toIdentity: string, payload: string): void {
        this.onOutgoingSignal.notify({
            fromIdentity: this.#localIdentity,
            toIdentity,
            signalType: "offer",
            payload,
        })
    }

    sendAnswer(toIdentity: string, payload: string): void {
        this.onOutgoingSignal.notify({
            fromIdentity: this.#localIdentity,
            toIdentity,
            signalType: "answer",
            payload,
        })
    }

    sendIceCandidate(toIdentity: string, payload: string): void {
        this.onOutgoingSignal.notify({
            fromIdentity: this.#localIdentity,
            toIdentity,
            signalType: "ice",
            payload,
        })
    }

    async handleIncomingSignal(signal: SignalMessage): Promise<void> {
        if (signal.toIdentity !== this.#localIdentity) {return}
        if (signal.signalType === "offer") {
            this.#peerManager.addPeer(signal.fromIdentity)
            const connection = this.#peerManager.getConnection(signal.fromIdentity)
            if (!isDefined(connection)) {return}
            await connection.setRemoteDescription(JSON.parse(signal.payload) as RTCSessionDescriptionInit)
            const answer = await connection.createAnswer()
            await connection.setLocalDescription(answer)
            this.sendAnswer(signal.fromIdentity, JSON.stringify(answer))
        } else if (signal.signalType === "answer") {
            this.#peerManager.addPeer(signal.fromIdentity)
            const connection = this.#peerManager.getConnection(signal.fromIdentity)
            if (!isDefined(connection)) {return}
            await connection.setRemoteDescription(JSON.parse(signal.payload) as RTCSessionDescriptionInit)
        } else if (signal.signalType === "ice") {
            const connection = this.#peerManager.getConnection(signal.fromIdentity)
            if (!isDefined(connection)) {return}
            await connection.addIceCandidate(JSON.parse(signal.payload) as RTCIceCandidateInit)
        }
    }

    terminate(): void {
        this.onOutgoingSignal.terminate()
    }
}
