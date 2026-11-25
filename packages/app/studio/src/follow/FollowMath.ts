import {isDefined, Nullable} from "@opendaw/lib-std"
import {ppqn, seconds, TempoMap} from "@opendaw/lib-dsp"

export type FollowLoop = {
    readonly enabled: boolean
    readonly from: ppqn
    readonly to: ppqn
}

// who follows whom, for every client present in the room
export type FollowLinks = ReadonlyMap<number, Nullable<number>>

export type FollowChain =
    | { readonly type: "leader", readonly leader: number }
    | { readonly type: "broken" }
    | { readonly type: "loop" }

// mirrors the engine: playback wraps at the loop end only when it started before it
export const advancePosition = (tempoMap: TempoMap, loop: FollowLoop, position: ppqn, elapsed: seconds): ppqn => {
    const start = tempoMap.ppqnToSeconds(position)
    const target = tempoMap.secondsToPPQN(start + elapsed)
    if (!loop.enabled || loop.from >= loop.to || position >= loop.to || target < loop.to) {return target}
    const loopStart = tempoMap.ppqnToSeconds(loop.from)
    const loopEnd = tempoMap.ppqnToSeconds(loop.to)
    const loopLength = loopEnd - loopStart
    if (loopLength <= 0.0) {return loop.from}
    return tempoMap.secondsToPPQN(loopStart + (start + elapsed - loopEnd) % loopLength)
}

export const resolveChain = (links: FollowLinks, start: number): FollowChain => {
    const walk = (current: number, visited: ReadonlySet<number>): FollowChain => {
        if (!links.has(current)) {return {type: "broken"}}
        if (visited.has(current)) {return {type: "loop"}}
        const next = links.get(current) ?? null
        if (!isDefined(next)) {return {type: "leader", leader: current}}
        return walk(next, new Set([...visited, current]))
    }
    return walk(start, new Set())
}

export const canFollow = (links: FollowLinks, self: number, target: number): boolean => {
    if (self === target || !links.has(target)) {return false}
    const chain = resolveChain(new Map(links).set(self, target), self)
    return chain.type === "leader" && chain.leader !== self
}

export const followersOf = (links: FollowLinks, leader: number): ReadonlyArray<number> =>
    Array.from(links.keys()).filter(clientId => {
        if (clientId === leader) {return false}
        const chain = resolveChain(links, clientId)
        return chain.type === "leader" && chain.leader === leader
    })
