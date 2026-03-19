import {int, MakeMutable, Terminable} from "@moises-ai/lib-std"
import {AudioBuffer, ppqn} from "@moises-ai/lib-dsp"
import {EventBuffer} from "./EventBuffer"

export const enum BlockFlag {
    // state (persistent across chunks within a block)
    transporting = 1 << 0,
    playing = 1 << 2,
    // events (one-shot, cleared after first chunk)
    discontinuous = 1 << 1,
    bpmChanged = 1 << 3,
    eventMask = discontinuous | bpmChanged
}

export namespace BlockFlags {
    export const create = (transporting: boolean,
                           discontinuous: boolean,
                           playing: boolean,
                           bpmChanged: boolean): int => 0
        | (transporting ? BlockFlag.transporting : 0)
        | (discontinuous ? BlockFlag.discontinuous : 0)
        | (playing ? BlockFlag.playing : 0)
        | (bpmChanged ? BlockFlag.bpmChanged : 0)
}

export type Block = Readonly<{
    index: int,
    p0: ppqn
    p1: ppqn
    s0: int
    s1: int
    bpm: number
    flags: int
}>

export type MutableBlock = MakeMutable<Block>

export enum ProcessPhase {Before, After}

export interface ProcessInfo {
    blocks: ReadonlyArray<Block>
}

export interface Processor extends EventReceiver {
    reset(): void
    process(processInfo: ProcessInfo): void
}

export interface EventReceiver {
    get eventInput(): EventBuffer
}

export interface AudioGenerator {
    get audioOutput(): AudioBuffer
}

export interface EventGenerator {
    setEventTarget(target: EventBuffer): Terminable
}

export interface AudioInput {
    setAudioSource(source: AudioBuffer): Terminable
}