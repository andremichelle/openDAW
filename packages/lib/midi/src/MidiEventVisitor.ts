import {byte, unitValue} from "@moises-ai/lib-std"
import {ppqn} from "@moises-ai/lib-dsp"

export interface MidiEventVisitor {
    noteOn?(note: byte, velocity: byte): void
    noteOff?(note: byte): void
    pitchBend?(delta: number): void
    controller?(id: byte, value: unitValue): void
    clock?(): void
    start?(): void
    continue?(): void
    stop?(): void
    songPos?(position: ppqn): void
}