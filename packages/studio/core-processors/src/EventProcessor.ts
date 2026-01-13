import {Block, ProcessInfo} from "./processing"
import {Event, PPQN, ppqn} from "@moises-ai/lib-dsp"
import {Maybe} from "@moises-ai/lib-std"
import {AbstractProcessor} from "./AbstractProcessor"
import {UpdateEvent} from "./UpdateClock"

export abstract class EventProcessor extends AbstractProcessor {
    process({blocks}: ProcessInfo): void {
        blocks.forEach((block) => {
            this.introduceBlock(block)
            const {index, p0, p1, s0, bpm} = block
            let anyEvents: Maybe<Array<Event>> = null
            let position = p0
            for (const event of this.eventInput.get(index)) {
                anyEvents?.forEach(event => this.handleEvent(block, event))
                anyEvents = null
                if (position < event.position) {
                    this.processEvents(block, position, event.position)
                    position = event.position
                }
                if (UpdateEvent.isOfType(event)) {
                    this.updateParameters(event.position, s0 / sampleRate + PPQN.pulsesToSeconds(event.position - p0, bpm))
                } else {
                    (anyEvents ??= []).push(event)
                }
            }
            anyEvents?.forEach(event => this.handleEvent(block, event))
            anyEvents = null
            if (position < p1) {
                this.processEvents(block, position, p1)
            }
        })
        this.eventInput.clear()
    }

    abstract handleEvent(block: Block, event: Event): void
    abstract processEvents(block: Block, from: ppqn, to: ppqn): void

    introduceBlock(_block: Block): void {}
}