import {Notifier, Terminable} from "@opendaw/lib-std"

export class PeerManager implements Terminable {
    readonly #peers: Map<string, RTCPeerConnection> = new Map()
    readonly onPeerConnected: Notifier<string> = new Notifier()
    readonly onPeerDisconnected: Notifier<string> = new Notifier()

    get peerIds(): ReadonlyArray<string> {
        return Array.from(this.#peers.keys())
    }

    addPeer(peerId: string): void {
        if (this.#peers.has(peerId)) {return}
        this.#peers.set(peerId, new RTCPeerConnection())
        this.onPeerConnected.notify(peerId)
    }

    removePeer(peerId: string): void {
        const connection = this.#peers.get(peerId)
        if (connection === undefined) {return}
        connection.close()
        this.#peers.delete(peerId)
        this.onPeerDisconnected.notify(peerId)
    }

    getConnection(peerId: string): RTCPeerConnection | undefined {
        return this.#peers.get(peerId)
    }

    terminate(): void {
        for (const [peerId, connection] of this.#peers) {
            connection.close()
            this.onPeerDisconnected.notify(peerId)
        }
        this.#peers.clear()
        this.onPeerConnected.terminate()
        this.onPeerDisconnected.terminate()
    }
}
