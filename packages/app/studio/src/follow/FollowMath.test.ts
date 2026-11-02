import {describe, expect, it} from "vitest"
import {Nullable} from "@opendaw/lib-std"
import {TempoMap} from "@opendaw/lib-dsp"
import {advancePosition, canFollow, FollowLoop, followersOf, resolveChain} from "./FollowMath"

// 120 bpm until 3840 pulses (2 seconds), 60 bpm after: 1920 pulses per second, then 960
const TempoChange = 3840
const varying = {
    ppqnToSeconds: (position: number) => position <= TempoChange
        ? position / 1920 : TempoChange / 1920 + (position - TempoChange) / 960,
    secondsToPPQN: (time: number) => time <= TempoChange / 1920
        ? time * 1920 : TempoChange + (time - TempoChange / 1920) * 960
} as unknown as TempoMap
const constant = {
    ppqnToSeconds: (position: number) => position / 1920,
    secondsToPPQN: (time: number) => time * 1920
} as unknown as TempoMap

const NoLoop: FollowLoop = {enabled: false, from: 0, to: 3840}
const Loop: FollowLoop = {enabled: true, from: 0, to: 3840}

describe("advancePosition", () => {
    it("advances through a constant tempo", () => {
        expect(advancePosition(constant, NoLoop, 0, 1.0)).toBeCloseTo(1920)
        expect(advancePosition(constant, NoLoop, 1920, -0.5)).toBeCloseTo(960)
    })
    it("follows a tempo change on the way", () => {
        expect(advancePosition(varying, NoLoop, 3000, 1.0)).toBeCloseTo(4380)
    })
    it("wraps at the loop end like the engine", () => {
        expect(advancePosition(constant, Loop, 3000, 1.0)).toBeCloseTo(1080)
    })
    it("wraps several times for long distances", () => {
        expect(advancePosition(constant, Loop, 3000, 5.0)).toBeCloseTo(1080)
    })
    it("measures the loop through the tempo map", () => {
        const loop: FollowLoop = {enabled: true, from: 1920, to: 4800}
        // loop is 1s at 120 bpm plus 1s at 60 bpm, 2.0 seconds long
        expect(advancePosition(varying, loop, 4320, 1.0)).toBeCloseTo(1920 + 0.5 * 1920)
    })
    it("does not wrap before the loop end", () => {
        expect(advancePosition(constant, Loop, 0, 1.0)).toBeCloseTo(1920)
    })
    it("does not wrap when playback starts behind the loop end", () => {
        expect(advancePosition(constant, Loop, 4000, 1.0)).toBeCloseTo(5920)
    })
    it("does not wrap a disabled or empty loop", () => {
        expect(advancePosition(constant, NoLoop, 3000, 1.0)).toBeCloseTo(4920)
        expect(advancePosition(constant, {enabled: true, from: 3840, to: 3840}, 3000, 1.0)).toBeCloseTo(4920)
    })
})

const links = (entries: ReadonlyArray<[number, Nullable<number>]>) => new Map(entries)

describe("follow chains", () => {
    it("resolves to the person at the end", () => {
        const room = links([[1, null], [2, 1], [3, 2]])
        expect(resolveChain(room, 3)).toEqual({type: "leader", leader: 1})
        expect(resolveChain(room, 1)).toEqual({type: "leader", leader: 1})
    })
    it("breaks when someone in the chain is gone", () => {
        expect(resolveChain(links([[2, 1], [3, 2]]), 3)).toEqual({type: "broken"})
        expect(resolveChain(links([[1, null]]), 7)).toEqual({type: "broken"})
    })
    it("detects loops", () => {
        expect(resolveChain(links([[1, 2], [2, 1]]), 1)).toEqual({type: "loop"})
        expect(resolveChain(links([[1, 1]]), 1)).toEqual({type: "loop"})
    })
    it("refuses to follow yourself, absent people and anyone leading back to you", () => {
        const room = links([[1, null], [2, 1], [3, 2], [4, null]])
        expect(canFollow(room, 1, 1)).toBe(false)
        expect(canFollow(room, 1, 9)).toBe(false)
        expect(canFollow(room, 1, 3)).toBe(false)
        expect(canFollow(room, 4, 3)).toBe(true)
        expect(canFollow(room, 1, 4)).toBe(true)
    })
    it("lists everybody whose chain ends at the leader", () => {
        const room = links([[1, null], [2, 1], [3, 2], [4, null], [5, 4]])
        expect(followersOf(room, 1)).toEqual([2, 3])
        expect(followersOf(room, 4)).toEqual([5])
        expect(followersOf(room, 2)).toEqual([])
    })
})
