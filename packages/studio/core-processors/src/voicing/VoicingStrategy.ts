import {Arrays, EmptyExec, Id, int, panic} from "@moises-ai/lib-std"
import {AudioBuffer, NoteEvent} from "@moises-ai/lib-dsp"
import {Block} from "../processing"
import {Voice} from "./Voice"

export interface VoicingStrategy {
    start(event: Id<NoteEvent>): void
    stop(id: int): void
    forceStop(): void
    process(output: AudioBuffer, block: Block, fromIndex: int, toIndex: int): boolean // true if idle
    reset(): void
    processing(): ReadonlyArray<Voice>
}

export namespace VoicingStrategy {
    export const NotSet: VoicingStrategy = {
        start: () => panic("VoicingStrategy.start"),
        stop: () => panic("VoicingStrategy.stop"),
        forceStop: () => EmptyExec,
        process: () => panic("VoicingStrategy.process"),
        reset: EmptyExec,
        processing: (): ReadonlyArray<Voice> => Arrays.empty()
    }
}