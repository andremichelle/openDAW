import {AnyClipBoxAdapter} from "@moises-ai/studio-adapters"
import {int} from "@moises-ai/lib-std"

export interface ClipModifyStrategies {
    showOrigin(): boolean
    selectedModifyStrategy(): ClipModifyStrategy
    unselectedModifyStrategy(): ClipModifyStrategy
}

export namespace ClipModifyStrategies {
    export const Identity: ClipModifyStrategies = Object.freeze({
        showOrigin: (): boolean => false,
        selectedModifyStrategy: (): ClipModifyStrategy => ClipModifyStrategy.Identity,
        unselectedModifyStrategy: (): ClipModifyStrategy => ClipModifyStrategy.Identity
    })
}

export interface ClipModifyStrategy {
    readClipIndex(clip: AnyClipBoxAdapter): int
    readMirror(clip: AnyClipBoxAdapter): boolean
    translateTrackIndex(index: int): int
}

export namespace ClipModifyStrategy {
    export const Identity: ClipModifyStrategy = Object.freeze({
        readClipIndex: (clip: AnyClipBoxAdapter): number => clip.indexField.getValue(),
        readMirror: (clip: AnyClipBoxAdapter): boolean => clip.canMirror && clip.isMirrowed,
        translateTrackIndex: (index: number): number => index
    })
}