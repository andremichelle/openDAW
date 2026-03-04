import {Notifier, Terminable} from "@opendaw/lib-std"
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

    handleIncomingSignal(signal: SignalMessage): void {
        if (signal.toIdentity !== this.#localIdentity) {return}
        if (signal.signalType === "offer") {
            this.#peerManager.addPeer(signal.fromIdentity)
            this.sendAnswer(signal.fromIdentity, '{"sdp":"auto-answer"}')
        } else if (signal.signalType === "answer") {
            this.#peerManager.addPeer(signal.fromIdentity)
        }
    }

    terminate(): void {
        this.onOutgoingSignal.terminate()
    }
}
