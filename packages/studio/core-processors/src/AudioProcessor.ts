import {Event, PPQN} from "@opendaw/lib-dsp"
import {assert, Maybe, panic} from "@opendaw/lib-std"
import {Block, BlockFlag, MutableBlock, ProcessInfo} from "./processing"
import {AbstractProcessor} from "./AbstractProcessor"
import {UpdateEvent} from "./UpdateClock"
import {EngineContext} from "./EngineContext"

export abstract class AudioProcessor extends AbstractProcessor {
    readonly #chunk: MutableBlock = {index: 0, p0: 0, p1: 0, s0: 0, s1: 0, bpm: 0, flags: 0}

    protected constructor(context: EngineContext) {
        super(context)
    }

    process({blocks}: ProcessInfo): void {
        blocks.forEach((block) => {
            this.introduceBlock(block)
            const {index, p0, s0, s1, bpm} = block
            const chunk: MutableBlock = Object.assign(this.#chunk, block)
            let anyEvents: Maybe<Array<Event>> = null
            for (const event of this.eventInput.get(index)) {
                const pulses = event.position - p0
                const toIndex = Math.abs(pulses) < 1.0e-7 ? s0 : s0 + Math.floor(PPQN.pulsesToSamples(pulses, bpm, sampleRate))
                assert(s0 <= toIndex && toIndex <= s1, () => `${toIndex} out of bounds. event: ${event.position} (${event.type}), p0: ${p0}`)
                anyEvents?.forEach(event => this.handleEvent(event))
                anyEvents = null
                if (chunk.s0 < toIndex) {
                    chunk.s1 = toIndex
                    chunk.p1 = event.position
                    this.processAudio(chunk)
                    chunk.s0 = toIndex
                    chunk.p0 = event.position
                    chunk.flags &= ~BlockFlag.eventMask
                }
                if (UpdateEvent.isOfType(event)) {
                    this.updateParameters(event.position, s0 / sampleRate + PPQN.pulsesToSeconds(event.position - p0, bpm))
                } else {
                    (anyEvents ??= []).push(event)
                }
            }
            anyEvents?.forEach(event => this.handleEvent(event))
            anyEvents = null
            if (chunk.s0 < s1) {
                chunk.s1 = s1
                chunk.p1 = block.p1
                this.processAudio(chunk)
            }
        })
        this.eventInput.clear()
        this.finishProcess()
    }

    abstract processAudio(block: Block): void

    introduceBlock(_block: Block): void {}

    handleEvent(_event: Event): void {return panic(`${this} received an event but has no accepting method.`)}

    finishProcess(): void {}
}