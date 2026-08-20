import {clamp, int} from "@opendaw/lib-std"

export const ClipWidth = 49 // make a better connection to the CSS variables and adjustable
export const MaxClipCount: int = 9

export const clampClipMoveDelta = (
    requestedDelta: int,
    clipIndices: ReadonlyArray<int>,
    maxClipCount: int
): int => clipIndices.reduce((delta, index) =>
    clamp(delta, -index, maxClipCount - index - 1), requestedDelta)

export const movedClipCount = (
    minimumCount: int,
    clipIndices: ReadonlyArray<int>,
    delta: int
): int => clipIndices.reduce((count, index) => Math.max(count, index + delta + 1), minimumCount)

export const clampClipCount = (requestedCount: int, minimumCount: int): int =>
    clamp(requestedCount, Math.max(1, minimumCount), Math.max(MaxClipCount, minimumCount))
