import {RegionBound} from "./env"
import {Option} from "@opendaw/lib-std"
import {dbToGain, LoopableRegion, PPQN, TempoChangeGrid, TempoMap} from "@opendaw/lib-dsp"
import {Peaks, PeaksPainter} from "@opendaw/lib-fusion"
import {AudioFileBoxAdapter, AudioPlayMode} from "@opendaw/studio-adapters"
import {TimelineRange} from "../timeline/TimelineRange"

export namespace AudioRenderer {
    type Segment = {
        x0: number
        x1: number
        u0: number
        u1: number
        outside: boolean
    }

    export const render = (
        context: CanvasRenderingContext2D,
        range: TimelineRange,
        file: AudioFileBoxAdapter,
        tempoMap: TempoMap,
        playMode: Option<AudioPlayMode>,
        waveformOffset: number,
        gain: number,
        {top, bottom}: RegionBound,
        contentColor: string,
        {rawStart, resultStart, resultEnd}: LoopableRegion.LoopCycle,
        clip: boolean = true
    ) => {
        if (file.peaks.isEmpty()) {return}
        const peaks: Peaks = file.peaks.unwrap()
        const durationInSeconds = file.endInSeconds - file.startInSeconds
        const numFrames = peaks.numFrames
        const numberOfChannels = peaks.numChannels
        const ht = bottom - top
        const peaksHeight = Math.floor((ht - 4) / numberOfChannels)
        const scale = dbToGain(-gain)
        const segments: Array<Segment> = []
        if (playMode.nonEmpty()) {
            const {warpMarkers} = playMode.unwrap()
            const markers = warpMarkers.asArray()
            if (markers.length < 2) {return}
            const first = markers[0]
            const second = markers[1]
            const secondLast = markers[markers.length - 2]
            const last = markers[markers.length - 1]
            const firstRate =
                (second.seconds - first.seconds) /
                (second.position - first.position)
            const lastRate =
                (last.seconds - secondLast.seconds) /
                (last.position - secondLast.position)
            const addSegment = (
                posStart: number,
                posEnd: number,
                audioStart: number,
                audioEnd: number,
                outside: boolean
            ) => {
                if (posStart >= posEnd) {return}
                if (posStart > range.unitMax || posEnd < range.unitMin) {return}
                const clippedStart = Math.max(
                    posStart,
                    range.unitMin - range.unitPadding
                )
                const clippedEnd = Math.min(posEnd, range.unitMax)
                if (clippedStart >= clippedEnd) {return}
                const t0 = (clippedStart - posStart) / (posEnd - posStart)
                const t1 = (clippedEnd - posStart) / (posEnd - posStart)
                let aStart = audioStart + t0 * (audioEnd - audioStart) + waveformOffset
                let aEnd = audioStart + t1 * (audioEnd - audioStart) + waveformOffset
                let x0 = range.unitToX(clippedStart) * devicePixelRatio
                let x1 = range.unitToX(clippedEnd) * devicePixelRatio
                if (aStart < 0.0) {
                    const ratio = -aStart / (aEnd - aStart)
                    x0 = x0 + ratio * (x1 - x0)
                    aStart = 0.0
                }
                if (aEnd > durationInSeconds) {
                    const ratio = (aEnd - durationInSeconds) / (aEnd - aStart)
                    x1 = x1 - ratio * (x1 - x0)
                    aEnd = durationInSeconds
                }
                if (aStart >= aEnd) {return}
                segments.push({
                    x0,
                    x1,
                    u0: (aStart / durationInSeconds) * numFrames,
                    u1: (aEnd / durationInSeconds) * numFrames,
                    outside
                })
            }
            const handleSegment = (
                segmentStart: number,
                segmentEnd: number,
                audioStartSeconds: number,
                audioEndSeconds: number
            ) => {
                if (segmentStart >= segmentEnd) {return}
                if (clip) {
                    if (segmentEnd <= resultStart || segmentStart >= resultEnd) {return}
                    const clippedStart = Math.max(segmentStart, resultStart)
                    const clippedEnd = Math.min(segmentEnd, resultEnd)
                    const t0 = (clippedStart - segmentStart) / (segmentEnd - segmentStart)
                    const t1 = (clippedEnd - segmentStart) / (segmentEnd - segmentStart)
                    const aStart = audioStartSeconds + t0 * (audioEndSeconds - audioStartSeconds)
                    const aEnd = audioStartSeconds + t1 * (audioEndSeconds - audioStartSeconds)
                    addSegment(clippedStart, clippedEnd, aStart, aEnd, false)
                } else {
                    const rate = (audioEndSeconds - audioStartSeconds) / (segmentEnd - segmentStart)
                    // Before audible
                    if (segmentStart < resultStart) {
                        const endPos = Math.min(segmentEnd, resultStart)
                        const aEnd = audioStartSeconds + (endPos - segmentStart) * rate
                        addSegment(segmentStart, endPos, audioStartSeconds, aEnd, true)
                    }
                    // Audible
                    if (segmentEnd > resultStart && segmentStart < resultEnd) {
                        const startPos = Math.max(segmentStart, resultStart)
                        const endPos = Math.min(segmentEnd, resultEnd)
                        const aStart = audioStartSeconds + (startPos - segmentStart) * rate
                        const aEnd = audioStartSeconds + (endPos - segmentStart) * rate
                        addSegment(startPos, endPos, aStart, aEnd, false)
                    }
                    // After audible
                    if (segmentEnd > resultEnd) {
                        const startPos = Math.max(segmentStart, resultEnd)
                        const aStart = audioStartSeconds + (startPos - segmentStart) * rate
                        addSegment(startPos, segmentEnd, aStart, audioEndSeconds, true)
                    }
                }
            }
            const visibleLocalStart =
                (clip ? resultStart : range.unitMin) - rawStart
            const visibleLocalEnd = (clip ? resultEnd : range.unitMax) - rawStart
            // With positive offset, audio from file start appears BEFORE first.position
            // With negative offset, audio from file end appears AFTER last.position
            const extraNeededBefore =
                waveformOffset > 0 ? waveformOffset / firstRate : 0
            const extraNeededAfter =
                waveformOffset < 0 ? -waveformOffset / lastRate : 0
            const extrapolateStartLocal = Math.min(
                visibleLocalStart,
                first.position - extraNeededBefore
            )
            const extrapolateEndLocal = Math.max(
                visibleLocalEnd,
                last.position + extraNeededAfter
            )
            // Extrapolate before the first warp marker
            if (extrapolateStartLocal < first.position) {
                const audioStart =
                    first.seconds +
                    (extrapolateStartLocal - first.position) * firstRate
                handleSegment(
                    rawStart + extrapolateStartLocal,
                    rawStart + first.position,
                    audioStart,
                    first.seconds
                )
            }
            // Interior warp segments - only iterate visible range
            const startIndex = Math.max(
                0,
                warpMarkers.floorLastIndex(visibleLocalStart)
            )
            for (let i = startIndex; i < markers.length - 1; i++) {
                const w0 = markers[i]
                if (w0.position > visibleLocalEnd) {
                    break
                }
                const w1 = markers[i + 1]
                handleSegment(
                    rawStart + w0.position,
                    rawStart + w1.position,
                    w0.seconds,
                    w1.seconds
                )
            }
            // Extrapolate after the last warp marker
            if (extrapolateEndLocal > last.position) {
                const audioEnd =
                    last.seconds + (extrapolateEndLocal - last.position) * lastRate
                handleSegment(
                    rawStart + last.position,
                    rawStart + extrapolateEndLocal,
                    last.seconds,
                    audioEnd
                )
            }
        } else {
            // Non-stretch mode - audio plays at 100% original speed
            // Audio time = elapsed timeline seconds since rawStart + waveformOffset
            // Use rawStart (not resultStart) because resultStart is clipped to viewport
            const regionStartSeconds = tempoMap.ppqnToSeconds(rawStart)

            // Use absolute time conversion so it works for positions before AND after rawStart
            const audioTimeAt = (ppqn: number): number =>
                tempoMap.ppqnToSeconds(ppqn) - regionStartSeconds + waveformOffset

            // Fixed step size for consistent rendering across zoom levels
            const addSegmentDirect = (
                ppqnStart: number,
                ppqnEnd: number,
                audioStart: number,
                audioEnd: number,
                outside: boolean
            ) => {
                if (ppqnStart >= ppqnEnd) {
                    return
                }
                if (
                    ppqnEnd < range.unitMin - range.unitPadding ||
                    ppqnStart > range.unitMax
                ) {
                    return
                }
                const clippedStart = Math.max(
                    ppqnStart,
                    range.unitMin - range.unitPadding
                )
                const clippedEnd = Math.min(ppqnEnd, range.unitMax)
                if (clippedStart >= clippedEnd) {
                    return
                }
                // Interpolate audio times for clipped range
                const t0 = (clippedStart - ppqnStart) / (ppqnEnd - ppqnStart)
                const t1 = (clippedEnd - ppqnStart) / (ppqnEnd - ppqnStart)
                let aStart = audioStart + t0 * (audioEnd - audioStart)
                let aEnd = audioStart + t1 * (audioEnd - audioStart)
                let x0 = range.unitToX(clippedStart) * devicePixelRatio
                let x1 = range.unitToX(clippedEnd) * devicePixelRatio
                if (aStart < 0) {
                    const ratio = -aStart / (aEnd - aStart)
                    x0 += ratio * (x1 - x0)
                    aStart = 0
                }
                if (aEnd > durationInSeconds) {
                    const ratio = (aEnd - durationInSeconds) / (aEnd - aStart)
                    x1 -= ratio * (x1 - x0)
                    aEnd = durationInSeconds
                }
                if (aStart >= aEnd) {
                    return
                }
                const u0 = (aStart / durationInSeconds) * numFrames
                const u1 = (aEnd / durationInSeconds) * numFrames
                if (u0 < u1 && x1 - x0 >= 1) {
                    segments.push({x0, x1, u0, u1, outside})
                }
            }

            // Similar to stretch mode: handle clipping at region boundaries
            const handleTempoSegment = (
                segStart: number,
                segEnd: number,
                audioStart: number,
                audioEnd: number
            ) => {
                if (segStart >= segEnd) {
                    return
                }
                if (clip) {
                    if (segEnd <= resultStart || segStart >= resultEnd) {
                        return
                    }
                    const clippedStart = Math.max(segStart, resultStart)
                    const clippedEnd = Math.min(segEnd, resultEnd)
                    const t0 = (clippedStart - segStart) / (segEnd - segStart)
                    const t1 = (clippedEnd - segStart) / (segEnd - segStart)
                    const aStart = audioStart + t0 * (audioEnd - audioStart)
                    const aEnd = audioStart + t1 * (audioEnd - audioStart)
                    addSegmentDirect(clippedStart, clippedEnd, aStart, aEnd, false)
                } else {
                    const rate = (audioEnd - audioStart) / (segEnd - segStart)
                    // Before audible region
                    if (segStart < resultStart) {
                        const endPos = Math.min(segEnd, resultStart)
                        const aEnd = audioStart + (endPos - segStart) * rate
                        addSegmentDirect(segStart, endPos, audioStart, aEnd, true)
                    }
                    // Audible region
                    if (segEnd > resultStart && segStart < resultEnd) {
                        const startPos = Math.max(segStart, resultStart)
                        const endPos = Math.min(segEnd, resultEnd)
                        const aStart = audioStart + (startPos - segStart) * rate
                        const aEnd = audioStart + (endPos - segStart) * rate
                        addSegmentDirect(startPos, endPos, aStart, aEnd, false)
                    }
                    // After audible region
                    if (segEnd > resultEnd) {
                        const startPos = Math.max(segStart, resultEnd)
                        const aStart = audioStart + (startPos - segStart) * rate
                        addSegmentDirect(startPos, segEnd, aStart, audioEnd, true)
                    }
                }
            }

            // Calculate iteration bounds
            // Where does audioTime = 0? Solve: ppqnToSeconds(ppqn) - regionStartSeconds + waveformOffset = 0
            const audioStartPPQN = tempoMap.secondsToPPQN(
                regionStartSeconds - waveformOffset
            )
            // Where does audioTime = durationInSeconds?
            const audioEndPPQN = tempoMap.secondsToPPQN(
                regionStartSeconds - waveformOffset + durationInSeconds
            )

            // Determine visible iteration range (include padding on the left for smooth scrolling)
            const iterStart = clip
                ? Math.max(resultStart, range.unitMin - range.unitPadding)
                : Math.max(
                    Math.min(audioStartPPQN, resultStart),
                    range.unitMin - range.unitPadding
                )
            const iterEnd = clip
                ? Math.min(resultEnd, range.unitMax + TempoChangeGrid)
                : Math.min(
                    Math.max(audioEndPPQN, resultEnd),
                    range.unitMax + TempoChangeGrid
                )

            // Dynamic step size: ensure each step is at least 1 device pixel wide
            const minStepSize = range.unitsPerPixel * devicePixelRatio
            const stepSize = Math.max(
                TempoChangeGrid,
                Math.ceil(minStepSize / TempoChangeGrid) * TempoChangeGrid
            )

            // Align to grid for consistent rendering across zoom levels
            let currentPPQN = Math.floor(iterStart / stepSize) * stepSize

            // Compute initial audio time once, then increment (avoid O(n) ppqnToSeconds calls per step)
            let currentAudioTime = audioTimeAt(currentPPQN)

            while (currentPPQN < iterEnd) {
                const nextPPQN = currentPPQN + stepSize
                // Incremental: get tempo at the current position and compute step duration
                const stepSeconds = PPQN.pulsesToSeconds(
                    stepSize,
                    tempoMap.getTempoAt(currentPPQN)
                )
                const nextAudioTime = currentAudioTime + stepSeconds

                // Skip if entirely outside audio file range
                if (nextAudioTime > 0 && currentAudioTime < durationInSeconds) {
                    handleTempoSegment(
                        currentPPQN,
                        nextPPQN,
                        currentAudioTime,
                        nextAudioTime
                    )
                }
                currentPPQN = nextPPQN
                currentAudioTime = nextAudioTime
            }
        }

        context.fillStyle = contentColor
        for (const {x0, x1, u0, u1, outside} of segments) {
            context.globalAlpha = outside && !clip ? 0.25 : 1.0
            for (let channel = 0; channel < numberOfChannels; channel++) {
                PeaksPainter.renderBlocks(context, peaks, channel, {
                    u0,
                    u1,
                    v0: -scale,
                    v1: +scale,
                    x0,
                    x1,
                    y0: 3 + top + channel * peaksHeight,
                    y1: 3 + top + (channel + 1) * peaksHeight
                })
            }
        }
    }
}