import {
    AudioClipBox,
    AudioRegionBox,
    BoxVisitor,
    NoteClipBox,
    NoteRegionBox,
    ValueClipBox,
    ValueRegionBox
} from "@moises-ai/studio-boxes"
import {Box} from "@moises-ai/lib-box"
import {panic} from "@moises-ai/lib-std"

export type AnyClipBox = NoteClipBox | ValueClipBox | AudioClipBox
export type AnyRegionBox = AudioRegionBox | NoteRegionBox | ValueRegionBox
export type AnyLoopableRegionBox = AnyRegionBox // TODO Clarify

export const UnionBoxTypes = {
    isClipBox: (box: Box): box is AnyClipBox => box.accept<BoxVisitor<boolean>>({
        visitNoteClipBox: (_box: NoteClipBox): boolean => true,
        visitAudioClipBox: (_box: AudioClipBox): boolean => true,
        visitValueClipBox: (_box: ValueClipBox): boolean => true
    }) ?? false,
    isRegionBox: (box: Box): box is AnyRegionBox => box.accept<BoxVisitor<boolean>>({
        visitNoteRegionBox: (_box: NoteRegionBox): boolean => true,
        visitAudioRegionBox: (_box: AudioRegionBox): boolean => true,
        visitValueRegionBox: (_box: ValueRegionBox): boolean => true
    }) ?? false,
    asRegionBox: (box: Box): AnyRegionBox => box.accept<BoxVisitor<AnyRegionBox>>({
        visitNoteRegionBox: (box: NoteRegionBox): AnyRegionBox => box,
        visitAudioRegionBox: (box: AudioRegionBox): AnyRegionBox => box,
        visitValueRegionBox: (box: ValueRegionBox): AnyRegionBox => box
    }) ?? panic("Could not cast to AnyRegionBox"),
    isLoopableRegionBox: (box: Box): box is AnyLoopableRegionBox => box.accept<BoxVisitor<boolean>>({
        visitNoteRegionBox: (_box: NoteRegionBox): boolean => true,
        visitAudioRegionBox: (_box: AudioRegionBox): boolean => true,
        visitValueRegionBox: (_box: ValueRegionBox): boolean => true
    }) ?? false
}