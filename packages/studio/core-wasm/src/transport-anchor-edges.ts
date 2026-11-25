import {int, Option} from "@opendaw/lib-std"
import {ppqn, RenderQuantum} from "@opendaw/lib-dsp"
import type {TransportAnchor} from "@opendaw/studio-adapters"

export type TransportJump = { readonly sample: int, readonly position: ppqn }

export type QuantumTransport = {
    readonly frame: number
    readonly sampleRate: number
    readonly isPlaying: boolean
    readonly isRecording: boolean
    readonly position: ppqn
    readonly jumps: ReadonlyArray<TransportJump>
    readonly pauseSample: int
}

// the anchors of one rendered quantum, from the post-render state and the engine's jumps inside the quantum
export class TransportAnchorEdges {
    #wasPlaying: boolean = false
    #wasRecording: boolean = false
    #position: ppqn = 0.0

    get wasPlaying(): boolean {return this.#wasPlaying}

    observe({frame, sampleRate, isPlaying, isRecording, position, jumps, pauseSample}: QuantumTransport)
        : ReadonlyArray<TransportAnchor> {
        const anchors: Array<TransportAnchor> = []
        const paused = pauseSample >= 0
        const recording = isRecording || (paused && this.#wasRecording)
        for (const jump of jumps) {
            anchors.push({kind: "jump", contextTime: (frame + jump.sample) / sampleRate, position: jump.position, recording})
        }
        if (!this.#wasPlaying && (isPlaying || paused)) {
            const sample = paused ? pauseSample : RenderQuantum
            anchors.push({kind: "start", contextTime: (frame + sample) / sampleRate, position, recording})
        }
        if (paused) {
            anchors.push({kind: "stop", contextTime: (frame + pauseSample) / sampleRate, position, recording})
        } else if (this.#wasPlaying && !isPlaying) {
            anchors.push({kind: "stop", contextTime: frame / sampleRate, position: this.#position, recording: this.#wasRecording})
        }
        this.#wasPlaying = isPlaying
        this.#wasRecording = isRecording
        this.#position = position
        return anchors
    }

    // a stop command between two renders: the last rendered quantum's end is the first frame it excludes
    close(contextTime: number): Option<TransportAnchor> {
        if (!this.#wasPlaying) {return Option.None}
        const anchor: TransportAnchor = {kind: "stop", contextTime, position: this.#position, recording: this.#wasRecording}
        this.#wasPlaying = false
        this.#wasRecording = false
        return Option.wrap(anchor)
    }
}
