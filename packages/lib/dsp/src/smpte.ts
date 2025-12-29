import {int} from "@opendaw/lib-std"

export type SMPTETime = Readonly<{
    hours: int
    minutes: int
    seconds: int
    frames: int
    subframes: int
}>

export type FrameRate = 24 | 25 | 29.97 | 30

const SubframesPerFrame = 80 as const

const toSeconds = (time: SMPTETime, fps: FrameRate): number =>
    time.hours * 3600 +
    time.minutes * 60 +
    time.seconds +
    time.frames / fps +
    time.subframes / (fps * SubframesPerFrame)

const fromSeconds = (seconds: number, fps: FrameRate): SMPTETime => {
    const totalSeconds = Math.floor(seconds)
    const hours = Math.floor(totalSeconds / 3600.0)
    const minutes = Math.floor((totalSeconds % 3600.0) / 60.0)
    const secs = totalSeconds % 60
    const fractionalSeconds = seconds - totalSeconds
    const totalFrames = fractionalSeconds * fps
    const frames = Math.floor(totalFrames)
    const subframes = Math.round((totalFrames - frames) * SubframesPerFrame)
    return {hours, minutes, seconds: secs, frames, subframes}
}

const toString = (time: SMPTETime): string => {
    const pad2 = (n: int) => n.toString().padStart(2, "0")
    return `${pad2(time.hours)}:${pad2(time.minutes)}:${pad2(time.seconds)}:${pad2(time.frames)}.${pad2(time.subframes)}`
}

const toShortString = (time: SMPTETime): string => {
    if (time.hours > 0) {return toString(time)}
    if (time.minutes > 0) {
        return `${time.minutes}m ${time.seconds}s ${time.frames}fr ${time.subframes}sub`
    }
    if (time.subframes > 0) {
        return `${time.seconds}s ${time.frames}fr ${time.subframes}sub`
    }
    if (time.frames > 0) {
        return `${time.seconds}s ${time.frames}fr`
    }
    return `${time.seconds}s`
}

const create = (seconds: int, frames: int = 0, subframes: int = 0): SMPTETime =>
    ({hours: 0, minutes: 0, seconds, frames, subframes})

export const SMPTE = {
    SubframesPerFrame,
    toSeconds,
    fromSeconds,
    toString,
    toShortString,
    create
} as const
