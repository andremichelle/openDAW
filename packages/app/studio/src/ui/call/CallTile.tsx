import {createElement} from "@opendaw/lib-jsx"
import {isDefined, Nullable, Procedure, Terminable, Terminator} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {CallService} from "@/call/CallService"
import {CallParticipant, hasLiveVideo} from "@/call/CallTypes"

export type CallTileKind = "main" | "screen"

const SpeakingThreshold = 0.22
const SpeakingHoldMs = 450

const qualityBars = (rtt: number, loss: number): number => {
    if (rtt < 0) {return 0}
    if (rtt < 0.08 && loss < 0.01) {return 3}
    if (rtt < 0.2 && loss < 0.04) {return 2}
    return 1
}

export class CallTile implements Terminable {
    readonly #terminator = new Terminator()
    readonly #call: CallService
    readonly #kind: CallTileKind
    readonly #element: HTMLElement
    readonly #video: HTMLVideoElement
    readonly #initial: HTMLElement
    readonly #name: HTMLElement
    readonly #volume: HTMLInputElement
    readonly #quality: HTMLElement

    #participant: CallParticipant
    #level: number = 0.0
    #speakingUntil: number = 0
    #qualityText: string = ""

    constructor(call: CallService, participant: CallParticipant, kind: CallTileKind,
                onPin: Procedure<CallTile>) {
        this.#call = call
        this.#participant = participant
        this.#kind = kind
        this.#video = <video autoplay playsInline muted/>
        this.#initial = <span className="initial"/>
        this.#name = <span className="name"/>
        this.#volume = <input type="range" min="0" max="1" step="0.01"/>
        this.#quality = <div className="quality"><i/><i/><i/></div>
        const pinButton: HTMLElement = (
            <button className="tool" onclick={() => onPin(this)}><Icon symbol={IconSymbol.Focus}/></button>
        )
        const fullscreenButton: HTMLElement = (
            <button className="tool" onclick={() => {
                if (isDefined(document.fullscreenElement)) {
                    document.exitFullscreen().catch(console.warn)
                } else {
                    this.#element.requestFullscreen().catch(console.warn)
                }
            }}><Icon symbol={IconSymbol.Fullscreen}/></button>
        )
        const volumeTool: HTMLElement = (
            <label className="volume"><Icon symbol={IconSymbol.Speaker}/>{this.#volume}</label>
        )
        this.#element = (
            <div className={`tile ${kind}`}>
                {this.#video}
                <div className="avatar">
                    <div className="ring"/>
                    {this.#initial}
                </div>
                <div className="badges">
                    <span className="hand"><Icon symbol={IconSymbol.CallHand}/></span>
                    <span className="hifi">DIRECT</span>
                </div>
                {this.#quality}
                <div className="label">
                    <span className="muted"><Icon symbol={IconSymbol.CallMicOff}/></span>
                    <span className="sharing"><Icon symbol={IconSymbol.CallScreen}/></span>
                    {this.#name}
                </div>
                <div className="tools">
                    {kind === "main" && !participant.self ? volumeTool : null}
                    {pinButton}
                    {fullscreenButton}
                </div>
                <div className="state"/>
            </div>
        )
        this.#element.style.setProperty("--user-color", participant.color)
        if (kind === "main" && !participant.self) {
            const volume = call.volume(participant.peerId)
            this.#volume.value = String(volume.getValue())
            this.#terminator.own(Events.subscribe(this.#volume, "input", () =>
                volume.setValue(parseFloat(this.#volume.value))))
            this.#terminator.own(volume.subscribe(owner => {
                this.#volume.value = String(owner.getValue())
                this.#element.classList.toggle("locally-muted", owner.getValue() === 0.0)
            }))
        }
        this.#terminator.own(TextTooltip.default(pinButton, () => "Pin"))
        this.#terminator.own(TextTooltip.default(fullscreenButton, () => "Fullscreen"))
        this.#terminator.own(TextTooltip.default(this.#quality, () => this.#qualityText))
        this.#terminator.own(Events.subscribe(this.#element, "dblclick", () => onPin(this)))
        this.update(participant)
    }

    get element(): HTMLElement {return this.#element}
    get participant(): CallParticipant {return this.#participant}
    get kind(): CallTileKind {return this.#kind}
    get key(): string {return CallTile.keyOf(this.#participant.peerId, this.#kind)}

    static keyOf(peerId: string, kind: CallTileKind): string {return `${peerId}:${kind}`}

    update(participant: CallParticipant): void {
        this.#participant = participant
        const {presence, self, name, color} = participant
        const stream: Nullable<MediaStream> = this.#kind === "screen"
            ? this.#call.screenStream(participant.peerId)
            : this.#call.mainStream(participant.peerId)
        const showVideo = (this.#kind === "screen" ? presence.screen : presence.camera) && hasLiveVideo(stream)
        if (showVideo && this.#video.srcObject !== stream) {
            this.#video.srcObject = stream
            this.#video.play().catch(() => {})
        } else if (!showVideo && isDefined(this.#video.srcObject)) {
            this.#video.srcObject = null
        }
        this.#element.style.setProperty("--user-color", color)
        this.#element.classList.toggle("video", showVideo)
        this.#element.classList.toggle("self", self)
        this.#element.classList.toggle("mirror", self && this.#kind === "main" && this.#call.mirror.getValue())
        this.#element.classList.toggle("mic-off", this.#kind === "main" && !presence.mic)
        this.#element.classList.toggle("hand-up", this.#kind === "main" && presence.hand)
        this.#element.classList.toggle("hifi", this.#kind === "main" && presence.music)
        const state = this.#call.connectionState(participant.peerId)
        this.#element.classList.toggle("connecting", state !== "connected")
        this.#element.classList.toggle("failed", state === "failed" || state === "disconnected")
        this.#initial.textContent = (name.trim().at(0) ?? "?").toUpperCase()
        this.#name.textContent = this.#kind === "screen"
            ? `${self ? "You are" : `${name} is`} presenting`
            : self ? `${name} (You)` : name
        const quality = this.#call.quality(participant.peerId)
        const bars = self ? 3 : isDefined(quality) ? qualityBars(quality.rtt, quality.loss) : 0
        this.#quality.dataset.bars = String(bars)
        this.#qualityText = self ? "This is you"
            : isDefined(quality) && quality.rtt >= 0
                ? `Round trip ${Math.round(quality.rtt * 1000)} ms, packet loss ${(quality.loss * 100).toFixed(1)}%`
                : `Connection: ${state}`
    }

    animate(now: number): void {
        if (this.#kind !== "main") {return}
        const target = this.#call.level(this.#participant.peerId)
        this.#level = target > this.#level ? target : this.#level * 0.85 + target * 0.15
        if (target > SpeakingThreshold) {this.#speakingUntil = now + SpeakingHoldMs}
        this.#element.style.setProperty("--level", this.#level.toFixed(3))
        this.#element.classList.toggle("speaking", now < this.#speakingUntil)
    }

    get speaking(): boolean {return this.#element.classList.contains("speaking")}

    terminate(): void {
        this.#video.srcObject = null
        this.#element.remove()
        this.#terminator.terminate()
    }
}
