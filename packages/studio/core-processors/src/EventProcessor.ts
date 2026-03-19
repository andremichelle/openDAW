import {Block, BlockFlag, MutableBlock, ProcessInfo} from "./processing"
import {Event, PPQN, ppqn} from "@moises-ai/lib-dsp"
import {Maybe} from "@moises-ai/lib-std"
import {AbstractProcessor} from "./AbstractProcessor"
import {UpdateEvent} from "./UpdateClock"

export abstract class EventProcessor extends AbstractProcessor {
    readonly #chunk: MutableBlock = {index: 0, p0: 0, p1: 0, s0: 0, s1: 0, bpm: 0, flags: 0}

    process({blocks}: ProcessInfo): void {
        blocks.forEach((block) => {
            this.introduceBlock(block)
            const {index, p0, p1, s0, bpm} = block
            const chunk: MutableBlock = Object.assign(this.#chunk, block)
            let anyEvents: Maybe<Array<Event>> = null
            for (const event of this.eventInput.get(index)) {
                anyEvents?.forEach(event => this.handleEvent(chunk, event))
                anyEvents = null
                if (chunk.p0 < event.position) {
                    chunk.p1 = event.position
                    this.processEvents(chunk, chunk.p0, event.position)
                    chunk.p0 = event.position
                    chunk.flags &= ~BlockFlag.eventMask
                }
                if (UpdateEvent.isOfType(event)) {
                    this.updateParameters(event.position, s0 / sampleRate + PPQN.pulsesToSeconds(event.position - p0, bpm))
                } else {
                    (anyEvents ??= []).push(event)
                }
            }
            anyEvents?.forEach(event => this.handleEvent(chunk, event))
            anyEvents = null
            if (chunk.p0 < p1) {
                chunk.p1 = p1
                this.processEvents(chunk, chunk.p0, p1)
            }
        })
        this.eventInput.clear()
    }

    abstract handleEvent(block: Block, event: Event): void
    abstract processEvents(block: Block, from: ppqn, to: ppqn): void

    introduceBlock(_block: Block): void {}
}