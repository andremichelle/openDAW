import {Id, int, unitValue} from "@moises-ai/lib-std"
import {NoteEvent, ppqn} from "@moises-ai/lib-dsp"
import {NoteLifecycleEvent} from "../../../NoteEventSource"

export type Stack = ReadonlyArray<Omit<NoteEvent, "position">>
export type VelocityMatrix = { mult: unitValue, add: unitValue }
export namespace VelocityMatrix {
    export const create = (): VelocityMatrix => ({mult: 1.0, add: 0.0})
    export const apply = (matrix: VelocityMatrix, velocity: unitValue): unitValue => velocity * matrix.mult + matrix.add
}

export interface Mode {
    get name(): string
    run(stack: Stack, octaves: int, stepIndex: int, position: ppqn, duration: ppqn, velocityMatrix: VelocityMatrix): Id<NoteEvent>
}

export const ArpeggioModes: ReadonlyArray<Mode> = Object.freeze([{
    name: "up",
    run: (stack: Stack,
          octaves: int,
          stepIndex: int,
          position: ppqn,
          duration: ppqn,
          velocityMatrix: VelocityMatrix): Id<NoteEvent> => {
        const count = stack.length
        const amount = count * octaves
        const localIndex = stepIndex % count
        const octave = Math.floor((stepIndex % amount) / count)
        const event = stack[localIndex]
        return NoteLifecycleEvent.start(
            position, duration, event.pitch + octave * 12, VelocityMatrix.apply(velocityMatrix, event.velocity))
    }
}, {
    name: "down",
    run: (stack: Stack,
          octaves: int,
          stepIndex: int,
          position: ppqn,
          duration: ppqn,
          velocityMatrix: VelocityMatrix): Id<NoteEvent> => {
        const count = stack.length
        const amount = count * octaves
        const localIndex = (count - 1) - stepIndex % count
        const octave = (octaves - 1) - Math.floor((stepIndex % amount) / count)
        const event = stack[localIndex]
        return NoteLifecycleEvent.start(
            position, duration, event.pitch + octave * 12, VelocityMatrix.apply(velocityMatrix, event.velocity))
    }
}, {
    name: "up-down",
    run: (stack: Stack,
          octaves: int,
          stepIndex: int,
          position: ppqn,
          duration: ppqn,
          velocityMatrix: VelocityMatrix): Id<NoteEvent> => {
        const count = stack.length
        const processLength = count * octaves
        const sequenceLength = Math.max(1, processLength * 2 - 2)
        const sequenceIndex = stepIndex % sequenceLength
        const processIndex = (sequenceIndex < processLength ? sequenceIndex : sequenceLength - sequenceIndex)
        const localIndex = processIndex % count
        const octave = Math.floor(processIndex / count)
        const event = stack[localIndex]
        return NoteLifecycleEvent.start(
            position, duration, event.pitch + octave * 12, VelocityMatrix.apply(velocityMatrix, event.velocity))
    }
}])