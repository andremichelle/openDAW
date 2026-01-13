import {EventCollection, ppqn} from "@moises-ai/lib-dsp"
import {Coordinates, int, Option, unitValue} from "@moises-ai/lib-std"

import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {UINoteEvent} from "@/ui/timeline/editors/notes/UINoteEvent.ts"

export type Point = Coordinates<number, unitValue> // time, value
export type Line = [Point, Point]

export interface NoteModifyStrategies {
    showOrigin(): boolean
    showCreation(): Option<UINoteEvent>
    showPropertyLine(): Option<Line>
    readContentDuration(owner: NoteEventOwnerReader): ppqn
    selectedModifyStrategy(): NoteModifyStrategy
    unselectedModifyStrategy(): NoteModifyStrategy
}

export namespace NoteModifyStrategies {
    export const Identity: NoteModifyStrategies = Object.freeze({
        showOrigin: (): boolean => false,
        showPropertyLine: (): Option<Line> => Option.None,
        showCreation: (): Option<UINoteEvent> => Option.None,
        readContentDuration: (region: NoteEventOwnerReader): ppqn => region.contentDuration,
        selectedModifyStrategy: (): NoteModifyStrategy => NoteModifyStrategy.Identity,
        unselectedModifyStrategy: (): NoteModifyStrategy => NoteModifyStrategy.Identity
    })
}

export interface NoteModifyStrategy {
    readPosition(note: UINoteEvent): ppqn
    readComplete(note: UINoteEvent): ppqn
    readPitch(note: UINoteEvent): int
    readVelocity(note: UINoteEvent): unitValue
    readCent(note: UINoteEvent): number
    readChance(note: UINoteEvent): number
    iterateRange<E extends UINoteEvent>(events: EventCollection<E>, from: ppqn, to: ppqn): Iterable<E>
}

export namespace NoteModifyStrategy {
    export const Identity: NoteModifyStrategy = Object.freeze({
        readPosition: (note: UINoteEvent): ppqn => note.position,
        readComplete: (note: UINoteEvent): ppqn => note.position + note.duration,
        readPitch: (note: UINoteEvent): number => note.pitch,
        readVelocity: (note: UINoteEvent): number => note.velocity,
        readCent: (note: UINoteEvent): number => note.cent,
        readChance: (note: UINoteEvent): number => note.chance,
        iterateRange: <E extends UINoteEvent>(events: EventCollection<E>,
                                              from: ppqn, to: ppqn): Iterable<E> => events.iterateRange(from, to)
    })
}