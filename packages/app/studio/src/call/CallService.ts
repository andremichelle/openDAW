import {
    DefaultObservableValue,
    isDefined,
    Notifier,
    Nullable,
    Observer,
    Optional,
    Subscription,
    Terminable,
    Terminator,
    TimeSpan,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {Promises, Wait} from "@opendaw/lib-runtime"
import {deferNextFrame} from "@opendaw/lib-dom"
import type {Awareness} from "y-protocols/awareness"
import {AwarenessUserState} from "@/service/RoomAwareness"
import {StudioService} from "@/service/StudioService"
import {CallPeer} from "@/call/CallPeer"
import {CallSignaling} from "@/call/CallSignaling"
import {CallMeter} from "@/call/CallMeter"
import {
    asCallPresence,
    CallParticipant,
    CallPresence,
    CallQuality,
    CallSignal,
    isTargeted
} from "@/call/CallTypes"

const SettingsKey = "opendaw:call:settings"
const PeerGraceMs = 10_000
const SignalingTimeoutSeconds = 5
const QualityIntervalMs = 2_000
const DuckGain = 0.25
const VoiceBitrate = 48_000
const MusicBitrate = 128_000
export const MaxCallSize = 6
const CallFullMessage = `The call is full. Up to ${MaxCallSize} people can take part.`

export type CallEvent =
    | { readonly type: "joined", readonly name: string }
    | { readonly type: "left", readonly name: string }
    | { readonly type: "hand", readonly name: string }
    | { readonly type: "call-started", readonly name: string }
    | { readonly type: "error", readonly message: string }

type CallSettings = {
    music: boolean
    duck: boolean
    silenceRecording: boolean
    mirror: boolean
    micId: string
    cameraId: string
    speakerId: string
}

const readSettings = (): CallSettings => {
    const fallback: CallSettings = {
        music: false, duck: false, silenceRecording: true, mirror: true, micId: "", cameraId: "", speakerId: ""
    }
    const result = tryCatch(() => JSON.parse(localStorage.getItem(SettingsKey) ?? "{}"))
    if (result.status === "failure" || typeof result.value !== "object" || !isDefined(result.value)) {return fallback}
    const stored: Record<string, unknown> = result.value
    return {
        music: typeof stored.music === "boolean" ? stored.music : fallback.music,
        duck: typeof stored.duck === "boolean" ? stored.duck : fallback.duck,
        silenceRecording: typeof stored.silenceRecording === "boolean"
            ? stored.silenceRecording : fallback.silenceRecording,
        mirror: typeof stored.mirror === "boolean" ? stored.mirror : fallback.mirror,
        micId: typeof stored.micId === "string" ? stored.micId : "",
        cameraId: typeof stored.cameraId === "string" ? stored.cameraId : "",
        speakerId: typeof stored.speakerId === "string" ? stored.speakerId : ""
    }
}

const describeMediaError = (error: unknown, device: string): string => {
    const name = error instanceof DOMException ? error.name : ""
    if (name === "NotAllowedError") {return `Access to the ${device} was denied.`}
    if (name === "NotFoundError" || name === "OverconstrainedError") {return `No ${device} found.`}
    if (name === "NotReadableError") {return `The ${device} is in use by another application.`}
    return `Could not start the ${device}.`
}

export class CallService implements Terminable {
    readonly #terminator = new Terminator()
    readonly #service: StudioService
    readonly #awareness: Awareness
    readonly #topic: string
    readonly #serverUrl: string
    readonly #changes: Notifier<void>
    readonly #events: Notifier<CallEvent>
    readonly #peers: Map<string, CallPeer> = new Map()
    readonly #peerCreated: Map<string, number> = new Map()
    readonly #volumes: Map<string, DefaultObservableValue<number>> = new Map()
    readonly #players: Map<string, HTMLAudioElement> = new Map()
    readonly #localMain: MediaStream = new MediaStream()
    readonly #knownNames: Map<string, string> = new Map()
    readonly #handsUp: Set<string> = new Set()
    readonly #notifyChange: () => void

    readonly joined: DefaultObservableValue<boolean>
    readonly joining: DefaultObservableValue<boolean>
    readonly mic: DefaultObservableValue<boolean>
    readonly camera: DefaultObservableValue<boolean>
    readonly screen: DefaultObservableValue<boolean>
    readonly hand: DefaultObservableValue<boolean>
    readonly music: DefaultObservableValue<boolean>
    readonly duck: DefaultObservableValue<boolean>
    readonly silenceRecording: DefaultObservableValue<boolean>
    readonly mirror: DefaultObservableValue<boolean>
    readonly micId: DefaultObservableValue<string>
    readonly cameraId: DefaultObservableValue<string>
    readonly speakerId: DefaultObservableValue<string>

    #session: Nullable<Terminator> = null
    #signaling: Nullable<CallSignaling> = null
    #meter: Nullable<CallMeter> = null
    #peerId: string = ""
    #joinedAt: number = 0
    #micTrack: Nullable<MediaStreamTrack> = null
    #cameraTrack: Nullable<MediaStreamTrack> = null
    #screenStream: Nullable<MediaStream> = null
    #pushToTalk: boolean = false
    #cameraPending: boolean = false
    #micPending: boolean = false
    #devices: ReadonlyArray<MediaDeviceInfo> = []
    #hiddenKinds: ReadonlyArray<MediaDeviceKind> = []
    #lastCallSize: number = 0

    constructor(service: StudioService, awareness: Awareness, roomName: string, serverUrl: string) {
        this.#service = service
        this.#awareness = awareness
        this.#topic = `call:${roomName}`
        this.#serverUrl = serverUrl
        this.#changes = this.#terminator.own(new Notifier<void>())
        this.#events = this.#terminator.own(new Notifier<CallEvent>())
        const settings = readSettings()
        this.joined = this.#terminator.own(new DefaultObservableValue(false))
        this.joining = this.#terminator.own(new DefaultObservableValue(false))
        this.mic = this.#terminator.own(new DefaultObservableValue(false))
        this.camera = this.#terminator.own(new DefaultObservableValue(false))
        this.screen = this.#terminator.own(new DefaultObservableValue(false))
        this.hand = this.#terminator.own(new DefaultObservableValue(false))
        this.music = this.#terminator.own(new DefaultObservableValue(settings.music))
        this.duck = this.#terminator.own(new DefaultObservableValue(settings.duck))
        this.silenceRecording = this.#terminator.own(new DefaultObservableValue(settings.silenceRecording))
        this.mirror = this.#terminator.own(new DefaultObservableValue(settings.mirror))
        this.micId = this.#terminator.own(new DefaultObservableValue(settings.micId))
        this.cameraId = this.#terminator.own(new DefaultObservableValue(settings.cameraId))
        this.speakerId = this.#terminator.own(new DefaultObservableValue(settings.speakerId))
        const deferred = this.#terminator.own(deferNextFrame(() => this.#changes.notify()))
        this.#notifyChange = deferred.request
        const persist = () => localStorage.setItem(SettingsKey, JSON.stringify({
            music: this.music.getValue(), duck: this.duck.getValue(),
            silenceRecording: this.silenceRecording.getValue(), mirror: this.mirror.getValue(),
            micId: this.micId.getValue(), cameraId: this.cameraId.getValue(), speakerId: this.speakerId.getValue()
        } satisfies CallSettings))
        ;[this.music, this.duck, this.silenceRecording, this.mirror]
            .forEach(value => this.#terminator.own(value.subscribe(() => persist())))
        ;[this.micId, this.cameraId, this.speakerId]
            .forEach(value => this.#terminator.own(value.subscribe(() => persist())))
        this.#terminator.own(this.mic.subscribe(() => this.#onLocalStateChanged()))
        this.#terminator.own(this.hand.subscribe(() => this.#onLocalStateChanged()))
        this.#terminator.own(this.music.subscribe(() => {
            if (this.joined.getValue()) {this.#restartMic().then()}
        }))
        this.#terminator.own(this.micId.subscribe(() => {
            if (this.joined.getValue()) {this.#restartMic().then()}
        }))
        this.#terminator.own(this.cameraId.subscribe(() => {
            if (this.joined.getValue() && this.camera.getValue()) {this.#startCamera().then()}
        }))
        this.#terminator.own(this.speakerId.subscribe(() => this.#players.forEach(player => this.#applySink(player))))
        this.#terminator.own(this.duck.subscribe(() => this.#applyVolumes()))
        this.#terminator.own(this.silenceRecording.subscribe(() => this.#applyVolumes()))
        this.#terminator.own(service.engine.isPlaying.subscribe(() => this.#applyVolumes()))
        this.#terminator.own(service.engine.isRecording.subscribe(() => this.#applyVolumes()))
        const onAwareness = () => this.#onAwarenessChanged()
        awareness.on("change", onAwareness)
        this.#terminator.own({terminate: () => awareness.off("change", onAwareness)})
        const onPageHide = () => this.leave()
        window.addEventListener("pagehide", onPageHide)
        this.#terminator.own({terminate: () => window.removeEventListener("pagehide", onPageHide)})
        const onDeviceChange = () => this.refreshDevices().then()
        navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange)
        this.#terminator.own({terminate: () => navigator.mediaDevices?.removeEventListener("devicechange", onDeviceChange)})
        const permissionStatuses: Array<PermissionStatus> = []
        this.#terminator.own({terminate: () => permissionStatuses.forEach(status => status.onchange = null)})
        const permissionNames: ReadonlyArray<PermissionName> = ["camera", "microphone"]
        permissionNames.forEach(name => {
            if (!isDefined(navigator.permissions?.query)) {return}
            Promises.tryCatch(navigator.permissions.query({name})).then(result => {
                if (result.status !== "resolved") {return}
                result.value.onchange = onDeviceChange
                permissionStatuses.push(result.value)
            })
        })
        this.refreshDevices().then()
        this.#lastCallSize = this.participants().length
    }

    get peerId(): string {return this.#peerId}
    get devices(): ReadonlyArray<MediaDeviceInfo> {return this.#devices}
    isHidden(kind: MediaDeviceKind): boolean {return this.#hiddenKinds.includes(kind)}
    get supportsScreenShare(): boolean {return isDefined(navigator.mediaDevices?.getDisplayMedia)}
    get supportsSpeakerSelection(): boolean {return typeof HTMLMediaElement.prototype.setSinkId === "function"}
    get pushToTalkActive(): boolean {return this.#pushToTalk}

    subscribeChanges(observer: Observer<void>): Subscription {return this.#changes.subscribe(observer)}
    subscribeEvents(observer: Observer<CallEvent>): Subscription {return this.#events.subscribe(observer)}

    get full(): boolean {
        return !this.joined.getValue()
            && this.participants().filter(participant => !participant.self).length >= MaxCallSize
    }

    #overCapacity(participants: ReadonlyArray<CallParticipant>): boolean {
        const ranked = [...participants].sort((first, second) =>
            first.presence.joinedAt - second.presence.joinedAt || first.peerId.localeCompare(second.peerId))
        return ranked.findIndex(participant => participant.self) >= MaxCallSize
    }

    participants(): ReadonlyArray<CallParticipant> {
        const result: Array<CallParticipant> = []
        const localId = this.#awareness.clientID
        this.#awareness.getStates().forEach((state, clientId) => {
            const presence = asCallPresence(state.call)
            const user: Optional<AwarenessUserState> = state.user
            if (!isDefined(presence) || !isDefined(user)) {return}
            const self = clientId === localId
            if (self && presence.peerId !== this.#peerId) {return}
            result.push({peerId: presence.peerId, clientId, name: user.name, color: user.color, self, presence})
        })
        return result.sort((first, second) => first.self === second.self
            ? first.presence.joinedAt - second.presence.joinedAt : first.self ? -1 : 1)
    }


    mainStream(peerId: string): Nullable<MediaStream> {
        if (peerId === this.#peerId) {return this.#localMain}
        const peer = this.#peers.get(peerId)
        if (!isDefined(peer)) {return null}
        const screenId = this.#presenceOf(peerId)?.screenStreamId ?? ""
        return peer.streams().find(stream => stream.id !== screenId) ?? null
    }

    screenStream(peerId: string): Nullable<MediaStream> {
        if (peerId === this.#peerId) {return this.#screenStream}
        const screenId = this.#presenceOf(peerId)?.screenStreamId ?? ""
        if (screenId === "") {return null}
        return this.#peers.get(peerId)?.stream(screenId) ?? null
    }

    connectionState(peerId: string): RTCPeerConnectionState {
        if (peerId === this.#peerId) {return "connected"}
        return this.#peers.get(peerId)?.connectionState ?? "new"
    }

    quality(peerId: string): Nullable<CallQuality> {return this.#peers.get(peerId)?.quality ?? null}

    level(peerId: string): number {
        if (!isDefined(this.#meter)) {return 0.0}
        if (peerId === this.#peerId && !this.#isMicLive()) {return 0.0}
        return this.#meter.level(peerId)
    }

    rawMicLevel(): number {return isDefined(this.#meter) ? this.#meter.level(this.#peerId) : 0.0}

    volume(peerId: string): DefaultObservableValue<number> {
        const existing = this.#volumes.get(peerId)
        if (isDefined(existing)) {return existing}
        const volume = new DefaultObservableValue(1.0)
        volume.subscribe(() => this.#applyVolumes())
        this.#volumes.set(peerId, volume)
        return volume
    }

    async join(withCamera: boolean): Promise<void> {
        if (this.joined.getValue() || this.joining.getValue()) {return}
        if (this.full) {
            this.#events.notify({type: "error", message: CallFullMessage})
            return
        }
        this.joining.setValue(true)
        const session = new Terminator()
        this.#session = session
        this.#peerId = UUID.toString(UUID.generate())
        this.#joinedAt = Date.now()
        this.#meter = new CallMeter()
        session.own({terminate: () => {this.#meter?.terminate()}})
        const micStarted = await this.#startMic()
        this.mic.setValue(micStarted)
        const signaling = session.own(new CallSignaling(`${this.#serverUrl}/signaling`, this.#topic,
            signal => this.#onSignal(signal), () => this.#onSignalingReconnect()))
        this.#signaling = signaling
        await Promise.race([signaling.ready(), Wait.timeSpan(TimeSpan.seconds(SignalingTimeoutSeconds))])
        if (this.#session !== session) {return}
        const quality = setInterval(() => {
            Promise.all(Array.from(this.#peers.values()).map(peer => peer.updateQuality()))
                .then(() => this.#notifyChange())
        }, QualityIntervalMs)
        session.own({terminate: () => clearInterval(quality)})
        this.joined.setValue(true)
        this.joining.setValue(false)
        this.#publishPresence()
        this.#syncPeers()
        this.#notifyChange()
        this.refreshDevices().then()
        if (withCamera) {this.#startCamera().then()}
    }

    leave(): void {
        if (!this.joined.getValue()) {return}
        this.#signaling?.publish({type: "bye", peerId: this.#peerId})
        this.#peers.forEach(peer => peer.terminate())
        this.#peers.clear()
        this.#peerCreated.clear()
        this.#players.forEach(player => this.#disposePlayer(player))
        this.#players.clear()
        this.#stopScreen(false)
        this.#stopCamera(false)
        this.#micTrack?.stop()
        if (isDefined(this.#micTrack)) {this.#localMain.removeTrack(this.#micTrack)}
        this.#micTrack = null
        this.#session?.terminate()
        this.#session = null
        this.#signaling = null
        this.#meter = null
        this.#pushToTalk = false
        this.joined.setValue(false)
        this.mic.setValue(false)
        this.hand.setValue(false)
        this.#awareness.setLocalStateField("call", null)
        this.#notifyChange()
    }

    async toggleMic(): Promise<void> {
        if (!this.joined.getValue()) {return}
        if (!isDefined(this.#micTrack) || this.#micTrack.readyState === "ended") {
            if (!await this.#startMic()) {return}
            this.mic.setValue(true)
            return
        }
        this.mic.setValue(!this.mic.getValue())
    }

    setPushToTalk(active: boolean): void {
        if (this.#pushToTalk === active) {return}
        this.#pushToTalk = active
        this.#applyMicEnabled()
        this.#notifyChange()
    }

    async toggleCamera(): Promise<void> {
        if (!this.joined.getValue()) {return}
        if (this.camera.getValue()) {
            this.#stopCamera(true)
        } else {
            await this.#startCamera()
        }
    }

    async toggleScreen(): Promise<void> {
        if (!this.joined.getValue()) {return}
        if (this.screen.getValue()) {
            this.#stopScreen(true)
            return
        }
        const options: DisplayMediaStreamOptions & { systemAudio: "include" } = {
            video: {frameRate: {ideal: 30}},
            audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false},
            systemAudio: "include"
        }
        const {status, value: stream, error} = await Promises.tryCatch(navigator.mediaDevices.getDisplayMedia(options))
        if (status === "rejected") {
            if (!(error instanceof DOMException && error.name === "NotAllowedError")) {
                this.#events.notify({type: "error", message: describeMediaError(error, "screen share")})
            }
            return
        }
        if (!this.joined.getValue()) {
            stream.getTracks().forEach(track => track.stop())
            return
        }
        stream.getVideoTracks().forEach(track => {
            track.contentHint = "detail"
            track.onended = () => this.#stopScreen(true)
        })
        stream.getAudioTracks().forEach(track => track.contentHint = "music")
        this.#screenStream = stream
        this.screen.setValue(true)
        this.#peers.forEach(peer => this.#attachScreen(peer))
        this.#publishPresence()
        this.#notifyChange()
    }

    toggleHand(): void {
        if (!this.joined.getValue()) {return}
        this.hand.setValue(!this.hand.getValue())
    }

    async refreshDevices(): Promise<void> {
        if (!isDefined(navigator.mediaDevices?.enumerateDevices)) {return}
        const {status, value} = await Promises.tryCatch(navigator.mediaDevices.enumerateDevices())
        if (status === "resolved") {
            this.#devices = value.filter(device => device.deviceId !== "")
            this.#hiddenKinds = Array.from(new Set(value
                .filter(device => device.deviceId === "" || device.label === "")
                .map(device => device.kind)))
            this.#notifyChange()
        }
    }

    async revealDevices(kind: MediaDeviceKind): Promise<void> {
        if (!isDefined(navigator.mediaDevices?.getUserMedia)) {return}
        const video = kind === "videoinput"
        const result = await Promises.tryCatch(navigator.mediaDevices.getUserMedia(video ? {video: true} : {audio: true}))
        if (result.status === "rejected") {
            this.#events.notify({type: "error", message: describeMediaError(result.error, video ? "camera" : "microphone")})
            return
        }
        result.value.getTracks().forEach(track => track.stop())
        await this.refreshDevices()
    }

    #deviceLabel(deviceId: string, fallback: string): string {
        const label = this.#devices.find(device => device.deviceId === deviceId)?.label ?? ""
        return label === "" ? fallback : label
    }

    terminate(): void {
        this.leave()
        this.#volumes.forEach(volume => volume.terminate())
        this.#volumes.clear()
        this.#terminator.terminate()
    }

    #presenceOf(peerId: string): Nullable<CallPresence> {
        return this.participants().find(participant => participant.peerId === peerId)?.presence ?? null
    }

    #isMicLive(): boolean {
        return isDefined(this.#micTrack) && (this.mic.getValue() || this.#pushToTalk)
    }

    #micConstraints(): MediaTrackConstraints {
        const deviceId = this.micId.getValue()
        const device = deviceId === "" ? {} : {deviceId: {exact: deviceId}}
        return this.music.getValue()
            ? {
                ...device, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
                channelCount: {ideal: 2}, sampleRate: {ideal: 48_000}
            }
            : {...device, echoCancellation: true, noiseSuppression: true, autoGainControl: true}
    }

    async #startMic(): Promise<boolean> {
        if (!isDefined(navigator.mediaDevices?.getUserMedia) || this.#micPending) {return false}
        this.#micPending = true
        const started = await this.#acquireMic()
        this.#micPending = false
        return started
    }

    async #acquireMic(): Promise<boolean> {
        const request = () => Promises.tryCatch(navigator.mediaDevices.getUserMedia({audio: this.#micConstraints()}))
        const first = await request()
        const retry = first.status === "rejected" && this.micId.getValue() !== ""
        if (retry) {
            const label = this.#deviceLabel(this.micId.getValue(), "selected microphone")
            this.#events.notify({
                type: "error",
                message: `${describeMediaError(first.error, label)} Using the default microphone.`
            })
            this.micId.setValue("")
        }
        const result = retry ? await request() : first
        if (result.status === "rejected") {
            this.#events.notify({type: "error", message: describeMediaError(result.error, "microphone")})
            return false
        }
        const track = result.value.getAudioTracks()[0]
        if (!isDefined(track)) {return false}
        track.contentHint = this.music.getValue() ? "music" : "speech"
        if (!this.joined.getValue() && !this.joining.getValue()) {
            track.stop()
            return false
        }
        const previous = this.#micTrack
        if (isDefined(previous)) {
            this.#localMain.removeTrack(previous)
            previous.stop()
        }
        this.#micTrack = track
        this.#localMain.addTrack(track)
        this.#applyMicEnabled()
        this.#peers.forEach(peer => this.#attachMain(peer))
        this.#meter?.watch(this.#peerId, this.#localMain)
        this.#notifyChange()
        this.refreshDevices().then()
        return true
    }

    async #restartMic(): Promise<void> {
        if (!isDefined(this.#micTrack)) {return}
        await this.#startMic()
        this.#publishPresence()
    }

    async #startCamera(): Promise<void> {
        if (!isDefined(navigator.mediaDevices?.getUserMedia) || this.#cameraPending) {return}
        this.#cameraPending = true
        await this.#acquireCamera()
        this.#cameraPending = false
    }

    async #acquireCamera(): Promise<void> {
        const request = () => {
            const deviceId = this.cameraId.getValue()
            return Promises.tryCatch(navigator.mediaDevices.getUserMedia({
                video: {
                    width: {ideal: 640}, height: {ideal: 360}, frameRate: {ideal: 24},
                    ...(deviceId === "" ? {} : {deviceId: {exact: deviceId}})
                }
            }))
        }
        const first = await request()
        const retry = first.status === "rejected" && this.cameraId.getValue() !== ""
        if (retry) {
            const label = this.#deviceLabel(this.cameraId.getValue(), "selected camera")
            this.#events.notify({
                type: "error",
                message: `${describeMediaError(first.error, label)} Using the default camera.`
            })
            this.cameraId.setValue("")
        }
        const result = retry ? await request() : first
        if (result.status === "rejected") {
            this.#events.notify({type: "error", message: describeMediaError(result.error, "camera")})
            return
        }
        const track = result.value.getVideoTracks()[0]
        if (!isDefined(track)) {return}
        if (!this.joined.getValue() && !this.joining.getValue()) {
            track.stop()
            return
        }
        track.contentHint = "motion"
        track.onended = () => this.#stopCamera(true)
        const previous = this.#cameraTrack
        if (isDefined(previous)) {
            this.#localMain.removeTrack(previous)
            previous.onended = null
            previous.stop()
        }
        this.#cameraTrack = track
        this.#localMain.addTrack(track)
        this.camera.setValue(true)
        this.#peers.forEach(peer => this.#attachMain(peer))
        this.#publishPresence()
        this.#notifyChange()
        this.refreshDevices().then()
    }

    #stopCamera(publish: boolean): void {
        const track = this.#cameraTrack
        if (!isDefined(track)) {return}
        track.onended = null
        track.stop()
        this.#localMain.removeTrack(track)
        this.#cameraTrack = null
        this.camera.setValue(false)
        this.#peers.forEach(peer => this.#attachMain(peer))
        if (publish) {this.#publishPresence()}
        this.#notifyChange()
    }

    #stopScreen(publish: boolean): void {
        const stream = this.#screenStream
        if (!isDefined(stream)) {return}
        stream.getTracks().forEach(track => {
            track.onended = null
            track.stop()
        })
        this.#screenStream = null
        this.screen.setValue(false)
        this.#peers.forEach(peer => this.#attachScreen(peer))
        if (publish) {this.#publishPresence()}
        this.#notifyChange()
    }

    #attachMain(peer: CallPeer): void {
        peer.setTrack("mic", this.#micTrack, this.#localMain)
        peer.setTrack("camera", this.#cameraTrack, this.#localMain)
        peer.setAudioBitrate(this.music.getValue() ? MusicBitrate : VoiceBitrate)
    }

    #attachScreen(peer: CallPeer): void {
        const stream = this.#screenStream ?? new MediaStream()
        peer.setTrack("screen-video", stream.getVideoTracks().at(0) ?? null, stream)
        peer.setTrack("screen-audio", stream.getAudioTracks().at(0) ?? null, stream)
    }

    #applyMicEnabled(): void {
        if (isDefined(this.#micTrack)) {this.#micTrack.enabled = this.#isMicLive()}
    }

    #onLocalStateChanged(): void {
        this.#applyMicEnabled()
        if (this.joined.getValue()) {this.#publishPresence()}
        this.#notifyChange()
    }

    #publishPresence(): void {
        if (!this.joined.getValue()) {return}
        this.#awareness.setLocalStateField("call", {
            peerId: this.#peerId,
            mic: this.mic.getValue(),
            camera: this.camera.getValue(),
            screen: this.screen.getValue(),
            hand: this.hand.getValue(),
            music: this.music.getValue(),
            screenStreamId: this.#screenStream?.id ?? "",
            joinedAt: this.#joinedAt
        } satisfies CallPresence)
    }

    #onAwarenessChanged(): void {
        const participants = this.participants()
        const remote = participants.filter(participant => !participant.self)
        const present = new Set(remote.map(participant => participant.peerId))
        if (this.joined.getValue() && this.#overCapacity(participants)) {
            this.leave()
            this.#events.notify({type: "error", message: CallFullMessage})
            return
        }
        if (this.joined.getValue()) {
            remote.forEach(participant => {
                if (!this.#knownNames.has(participant.peerId)) {
                    this.#events.notify({type: "joined", name: participant.name})
                }
            })
            this.#knownNames.forEach((name, peerId) => {
                if (!present.has(peerId)) {this.#events.notify({type: "left", name})}
            })
        } else if (this.#lastCallSize === 0 && remote.length > 0) {
            this.#events.notify({type: "call-started", name: remote[0].name})
        }
        remote.forEach(participant => {
            if (participant.presence.hand && !this.#handsUp.has(participant.peerId)) {
                this.#handsUp.add(participant.peerId)
                if (this.joined.getValue()) {this.#events.notify({type: "hand", name: participant.name})}
            } else if (!participant.presence.hand) {
                this.#handsUp.delete(participant.peerId)
            }
        })
        this.#knownNames.clear()
        remote.forEach(participant => this.#knownNames.set(participant.peerId, participant.name))
        this.#lastCallSize = remote.length
        this.#syncPeers()
        this.#notifyChange()
    }

    #syncPeers(): void {
        if (!this.joined.getValue()) {return}
        const now = Date.now()
        const remote = this.participants().filter(participant => !participant.self)
        const present = new Set(remote.map(participant => participant.peerId))
        remote.forEach(participant => this.#ensurePeer(participant.peerId))
        this.#peers.forEach((_peer, peerId) => {
            if (present.has(peerId)) {return}
            if (now - (this.#peerCreated.get(peerId) ?? 0) < PeerGraceMs) {return}
            this.#dropPeer(peerId)
        })
        this.#syncPlayback()
    }

    #ensurePeer(peerId: string): CallPeer {
        const existing = this.#peers.get(peerId)
        if (isDefined(existing)) {return existing}
        const peer = new CallPeer(this.#peerId, peerId,
            signal => this.#signaling?.publish(signal), () => {
                this.#syncPlayback()
                this.#notifyChange()
            })
        this.#peers.set(peerId, peer)
        this.#peerCreated.set(peerId, Date.now())
        this.#attachMain(peer)
        this.#attachScreen(peer)
        return peer
    }

    #dropPeer(peerId: string): void {
        const peer = this.#peers.get(peerId)
        if (!isDefined(peer)) {return}
        peer.terminate()
        this.#peers.delete(peerId)
        this.#peerCreated.delete(peerId)
        this.#meter?.unwatch(peerId)
        this.#syncPlayback()
        this.#notifyChange()
    }

    #onSignal(signal: CallSignal): void {
        if (!this.joined.getValue() || signal.peerId === this.#peerId || !isTargeted(signal, this.#peerId)) {return}
        switch (signal.type) {
            case "bye":
                this.#dropPeer(signal.peerId)
                return
            default: {
                this.#ensurePeer(signal.peerId).handle(signal)
            }
        }
    }

    #onSignalingReconnect(): void {
        Array.from(this.#peers.entries())
            .filter(([, peer]) => peer.connectionState !== "connected")
            .forEach(([peerId]) => this.#dropPeer(peerId))
        this.#syncPeers()
    }

    #syncPlayback(): void {
        const wanted = new Map<string, { stream: MediaStream, peerId: string }>()
        this.#peers.forEach((peer, peerId) => peer.streams().forEach(stream => {
            if (stream.getAudioTracks().length > 0) {wanted.set(stream.id, {stream, peerId})}
        }))
        this.#players.forEach((player, streamId) => {
            if (!wanted.has(streamId)) {
                this.#disposePlayer(player)
                this.#players.delete(streamId)
            }
        })
        wanted.forEach(({stream, peerId}, streamId) => {
            if (this.#players.has(streamId)) {return}
            const player = new Audio()
            player.autoplay = true
            player.srcObject = stream
            player.dataset.peerId = peerId
            this.#applySink(player)
            player.play().catch(() => window.addEventListener("pointerdown",
                () => player.play().catch(console.warn), {capture: true, once: true}))
            this.#players.set(streamId, player)
        })
        this.#peers.forEach((_peer, peerId) => this.#meter?.watch(peerId, this.mainStream(peerId)))
        if (this.#peerId !== "") {this.#meter?.watch(this.#peerId, this.#localMain)}
        this.#applyVolumes()
    }

    #disposePlayer(player: HTMLAudioElement): void {
        player.pause()
        player.srcObject = null
    }

    #applySink(player: HTMLAudioElement): void {
        if (!this.supportsSpeakerSelection) {return}
        player.setSinkId(this.speakerId.getValue()).catch(error => console.debug("[Call] setSinkId", error))
    }

    #applyVolumes(): void {
        const playing = this.#service.engine.isPlaying.getValue()
        const recording = this.#service.engine.isRecording.getValue()
        const master = recording && this.silenceRecording.getValue() ? 0.0
            : playing && this.duck.getValue() ? DuckGain : 1.0
        this.#players.forEach(player => {
            const peerId = player.dataset.peerId ?? ""
            const volume = this.#volumes.get(peerId)?.getValue() ?? 1.0
            player.volume = Math.max(0.0, Math.min(1.0, volume * master))
        })
    }
}
