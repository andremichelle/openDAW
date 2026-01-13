import {Event, PPQN} from "@moises-ai/lib-dsp"
import {assert, int, Maybe, panic} from "@moises-ai/lib-std"
import {Block, ProcessInfo} from "./processing"
import {AbstractProcessor} from "./AbstractProcessor"
import {UpdateEvent} from "./UpdateClock"
import {EngineContext} from "./EngineContext"

export abstract class AudioProcessor extends AbstractProcessor {
    protected constructor(context: EngineContext) {
        super(context)
    }

    process({blocks}: ProcessInfo): void {
        blocks.forEach((block) => {
            this.introduceBlock(block)
            const {index, p0, s0, s1, bpm} = block
            let anyEvents: Maybe<Array<Event>> = null
            let fromIndex = s0
            for (const event of this.eventInput.get(index)) {
                const pulses = event.position - p0
                const toIndex = Math.abs(pulses) < 1.0e-7 ? s0 : s0 + Math.floor(PPQN.pulsesToSamples(pulses, bpm, sampleRate))
                assert(s0 <= toIndex && toIndex <= s1, () => `${toIndex} out of bounds. event: ${event.position} (${event.type}), p0: ${p0}`)
                anyEvents?.forEach(event => this.handleEvent(event))
                anyEvents = null
                if (fromIndex < toIndex) {
                    this.processAudio(block, fromIndex, toIndex)
                    fromIndex = toIndex
                }
                if (UpdateEvent.isOfType(event)) {
                    this.updateParameters(event.position, s0 / sampleRate + PPQN.pulsesToSeconds(event.position - p0, bpm))
                } else {
                    (anyEvents ??= []).push(event)
                }
            }
            anyEvents?.forEach(event => this.handleEvent(event))
            anyEvents = null
            if (fromIndex < s1) {
                this.processAudio(block, fromIndex, s1)
            }
        })
        this.eventInput.clear()
        this.finishProcess()
    }

    abstract processAudio(block: Block, fromIndex: int, toIndex: int): void

    introduceBlock(_block: Block): void {}

    handleEvent(_event: Event): void {return panic(`${this} received an event but has no accepting method.`)}

    finishProcess(): void {}
}