import {isDefined, Nullable, Procedure, Terminable} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {RTC_CONFIG} from "@opendaw/studio-p2p"
import {CallQuality, CallSignal} from "@/call/CallTypes"

export type CallTrackSlot = "mic" | "camera" | "screen-video" | "screen-audio"

const OpusFmtp = "stereo=1;sprop-stereo=1;maxaveragebitrate=128000;useinbandfec=1"

export const mungeOpus = (sdp: string): string => {
    const match = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp)
    if (!isDefined(match)) {return sdp}
    const payload = match[1]
    return sdp.replace(new RegExp(`a=fmtp:${payload} ([^\\r\\n]*)`), (_line: string, params: string) => {
        const kept = params.split(";").filter(param => !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(param))
        return `a=fmtp:${payload} ${[...kept, ...OpusFmtp.split(";")]
            .filter((param, index, all) => all.indexOf(param) === index).join(";")}`
    })
}

const WatchdogMs = 2_000
const OfferResendTicks = 2

export class CallPeer implements Terminable {
    readonly #localPeerId: string
    readonly #remotePeerId: string
    readonly #polite: boolean
    readonly #send: Procedure<CallSignal>
    readonly #onChange: Procedure<void>
    readonly #connection: RTCPeerConnection
    readonly #senders: Map<CallTrackSlot, RTCRtpSender> = new Map()
    readonly #streams: Map<string, MediaStream> = new Map()
    readonly #watchdog: ReturnType<typeof setInterval>

    #makingOffer: boolean = false
    #ignoreOffer: boolean = false
    #audioBitrate: number = 0
    #queue: Promise<void> = Promise.resolve()
    #offerAge: number = 0
    #quality: Nullable<CallQuality> = null
    #terminated: boolean = false

    constructor(localPeerId: string, remotePeerId: string,
                send: Procedure<CallSignal>, onChange: Procedure<void>) {
        this.#localPeerId = localPeerId
        this.#remotePeerId = remotePeerId
        this.#polite = localPeerId > remotePeerId
        this.#send = send
        this.#onChange = onChange
        this.#connection = new RTCPeerConnection(RTC_CONFIG)
        this.#connection.onnegotiationneeded = () => this.#enqueue(() => this.#negotiate())
        this.#connection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
            if (!isDefined(event.candidate)) {return}
            this.#send({
                type: "candidate", peerId: this.#localPeerId, targetPeerId: this.#remotePeerId,
                candidate: event.candidate.toJSON()
            })
        }
        this.#connection.ontrack = (event: RTCTrackEvent) => {
            const stream = event.streams.at(0)
            if (!isDefined(stream)) {return}
            if (!this.#streams.has(stream.id)) {
                this.#streams.set(stream.id, stream)
                stream.onaddtrack = () => this.#onChange()
                stream.onremovetrack = () => this.#onChange()
            }
            event.track.onmute = () => this.#onChange()
            event.track.onunmute = () => this.#onChange()
            event.track.onended = () => this.#onChange()
            this.#onChange()
        }
        this.#watchdog = setInterval(() => this.#watch(), WatchdogMs)
        this.#connection.onconnectionstatechange = () => {
            const state = this.#connection.connectionState
            if (state === "failed") {this.#connection.restartIce()}
            if (state === "connected") {this.#applyAudioBitrate()}
            this.#onChange()
        }
    }

    get remotePeerId(): string {return this.#remotePeerId}
    get connectionState(): RTCPeerConnectionState {return this.#connection.connectionState}
    get quality(): Nullable<CallQuality> {return this.#quality}

    stream(id: string): Nullable<MediaStream> {return this.#streams.get(id) ?? null}
    streams(): ReadonlyArray<MediaStream> {return Array.from(this.#streams.values())}

    setTrack(slot: CallTrackSlot, track: Nullable<MediaStreamTrack>, stream: MediaStream): void {
        if (this.#terminated) {return}
        const sender = this.#senders.get(slot)
        if (isDefined(sender)) {
            if (isDefined(track)) {
                if (sender.track !== track) {sender.replaceTrack(track).catch(console.warn)}
            } else {
                this.#connection.removeTrack(sender)
                this.#senders.delete(slot)
            }
        } else if (isDefined(track)) {
            this.#senders.set(slot, this.#connection.addTrack(track, stream))
        }
    }

    setAudioBitrate(bitrate: number): void {
        this.#audioBitrate = bitrate
        this.#applyAudioBitrate()
    }

    #applyAudioBitrate(): void {
        const bitrate = this.#audioBitrate
        const sender = this.#senders.get("mic")
        if (!isDefined(sender) || bitrate === 0) {return}
        const parameters = sender.getParameters()
        if (parameters.encodings.length === 0) {return}
        parameters.encodings.forEach(encoding => {
            encoding.maxBitrate = bitrate
            encoding.priority = "high"
            encoding.networkPriority = "high"
        })
        sender.setParameters(parameters).catch(console.warn)
    }

    handle(signal: CallSignal): void {this.#enqueue(() => this.#process(signal))}

    #enqueue(task: () => Promise<void>): void {
        this.#queue = this.#queue.then(task).catch(error => console.warn("[Call] signal failed", error))
    }

    async #process(signal: CallSignal): Promise<void> {
        if (this.#terminated) {return}
        if (signal.type === "description") {
            const {description} = signal
            const collision = description.type === "offer"
                && (this.#makingOffer || this.#connection.signalingState !== "stable")
            this.#ignoreOffer = !this.#polite && collision
            if (this.#ignoreOffer) {return}
            await this.#connection.setRemoteDescription(description)
            if (description.type === "offer") {
                const answer = await this.#connection.createAnswer()
                await this.#connection.setLocalDescription({type: "answer", sdp: mungeOpus(answer.sdp ?? "")})
                this.#publishLocalDescription()
            }
            this.#applyAudioBitrate()
        } else if (signal.type === "candidate") {
            const {status, error} = await Promises.tryCatch(this.#connection.addIceCandidate(signal.candidate))
            if (status === "rejected" && !this.#ignoreOffer) {console.debug("[Call] candidate rejected", error)}
        }
    }

    async updateQuality(): Promise<void> {
        if (this.#terminated || this.#connection.connectionState !== "connected") {return}
        const {status, value: report} = await Promises.tryCatch(this.#connection.getStats())
        if (status === "rejected") {return}
        let rtt = -1
        let lost = 0
        let received = 0
        report.forEach((entry: RTCStats & Record<string, unknown>) => {
            if (entry.type === "candidate-pair" && entry.nominated === true
                && typeof entry.currentRoundTripTime === "number") {
                rtt = entry.currentRoundTripTime
            } else if (entry.type === "inbound-rtp" && entry.kind === "audio") {
                lost += typeof entry.packetsLost === "number" ? entry.packetsLost : 0
                received += typeof entry.packetsReceived === "number" ? entry.packetsReceived : 0
            }
        })
        this.#quality = {rtt, loss: received + lost > 0 ? lost / (received + lost) : 0}
    }

    terminate(): void {
        if (this.#terminated) {return}
        this.#terminated = true
        clearInterval(this.#watchdog)
        this.#connection.onnegotiationneeded = null
        this.#connection.onicecandidate = null
        this.#connection.ontrack = null
        this.#connection.onconnectionstatechange = null
        this.#connection.close()
        this.#streams.clear()
        this.#senders.clear()
    }

    #watch(): void {
        if (this.#connection.signalingState !== "have-local-offer") {
            this.#offerAge = 0
            return
        }
        if (++this.#offerAge < OfferResendTicks) {return}
        this.#offerAge = 0
        this.#publishLocalDescription()
    }

    async #negotiate(): Promise<void> {
        if (this.#terminated) {return}
        this.#makingOffer = true
        const {status, error} = await Promises.tryCatch((async () => {
            const offer = await this.#connection.createOffer()
            if (this.#connection.signalingState !== "stable") {return}
            await this.#connection.setLocalDescription({type: "offer", sdp: mungeOpus(offer.sdp ?? "")})
            this.#publishLocalDescription()
        })())
        this.#makingOffer = false
        if (status === "rejected") {console.warn("[Call] negotiation failed", error)}
    }

    #publishLocalDescription(): void {
        const description = this.#connection.localDescription
        if (!isDefined(description)) {return}
        this.#send({
            type: "description", peerId: this.#localPeerId, targetPeerId: this.#remotePeerId,
            description: {type: description.type, sdp: description.sdp}
        })
    }
}
