import {isDefined, Nullable, Terminable} from "@opendaw/lib-std"

type Probe = {
    readonly trackId: string
    readonly source: MediaStreamAudioSourceNode
    readonly analyser: AnalyserNode
    readonly buffer: Float32Array<ArrayBuffer>
}

export class CallMeter implements Terminable {
    readonly #context: AudioContext
    readonly #probes: Map<string, Probe> = new Map()
    readonly #unlisten: () => void

    constructor() {
        this.#context = new AudioContext({latencyHint: "playback"})
        const resume = () => {
            if (this.#context.state !== "suspended") {return}
            this.#context.resume().catch(console.warn)
        }
        resume()
        window.addEventListener("pointerdown", resume, {capture: true})
        window.addEventListener("keydown", resume, {capture: true})
        this.#unlisten = () => {
            window.removeEventListener("pointerdown", resume, {capture: true})
            window.removeEventListener("keydown", resume, {capture: true})
        }
    }

    watch(key: string, stream: Nullable<MediaStream>): void {
        const track = stream?.getAudioTracks().find(candidate => candidate.readyState === "live") ?? null
        const probe = this.#probes.get(key)
        if (isDefined(probe) && probe.trackId === track?.id) {return}
        this.unwatch(key)
        if (!isDefined(track)) {return}
        const source = this.#context.createMediaStreamSource(new MediaStream([track]))
        const analyser = this.#context.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        this.#probes.set(key, {trackId: track.id, source, analyser, buffer: new Float32Array(analyser.fftSize)})
    }

    unwatch(key: string): void {
        const probe = this.#probes.get(key)
        if (!isDefined(probe)) {return}
        probe.source.disconnect()
        this.#probes.delete(key)
    }

    level(key: string): number {
        const probe = this.#probes.get(key)
        if (!isDefined(probe)) {return 0.0}
        probe.analyser.getFloatTimeDomainData(probe.buffer)
        let sum = 0.0
        for (const sample of probe.buffer) {sum += sample * sample}
        const rms = Math.sqrt(sum / probe.buffer.length)
        const db = 20.0 * Math.log10(Math.max(rms, 1e-6))
        return Math.min(1.0, Math.max(0.0, (db + 60.0) / 50.0))
    }

    keys(): ReadonlyArray<string> {return Array.from(this.#probes.keys())}

    terminate(): void {
        this.#unlisten()
        this.#probes.forEach(probe => probe.source.disconnect())
        this.#probes.clear()
        this.#context.close().catch(console.warn)
    }
}
