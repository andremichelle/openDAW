import {isDefined, Notifier, Optional, Terminable} from "@opendaw/lib-std"

export class PeerManager implements Terminable {
    readonly #peers: Map<string, RTCPeerConnection> = new Map()
    readonly #dataChannels: Map<string, RTCDataChannel> = new Map()
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
        if (!isDefined(connection)) {return}
        connection.close()
        this.#peers.delete(peerId)
        const channel = this.#dataChannels.get(peerId)
        if (isDefined(channel)) {
            channel.close()
            this.#dataChannels.delete(peerId)
        }
        this.onPeerDisconnected.notify(peerId)
    }

    getConnection(peerId: string): Optional<RTCPeerConnection> {
        return this.#peers.get(peerId)
    }

    setDataChannel(peerId: string, channel: RTCDataChannel): void {
        const existing = this.#dataChannels.get(peerId)
        if (isDefined(existing)) {
            existing.close()
        }
        this.#dataChannels.set(peerId, channel)
    }

    getDataChannel(peerId: string): Optional<RTCDataChannel> {
        return this.#dataChannels.get(peerId)
    }

    terminate(): void {
        for (const [peerId, connection] of this.#peers) {
            connection.close()
            this.onPeerDisconnected.notify(peerId)
        }
        for (const [, channel] of this.#dataChannels) {
            channel.close()
        }
        this.#peers.clear()
        this.#dataChannels.clear()
        this.onPeerConnected.terminate()
        this.onPeerDisconnected.terminate()
    }
}
