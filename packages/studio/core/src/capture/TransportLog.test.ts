import {describe, expect, it} from "vitest"
import {DefaultObservableValue} from "@opendaw/lib-std"
import {ConstantTempoMap, PPQN} from "@opendaw/lib-dsp"
import {TransportAnchor} from "@opendaw/studio-adapters"
import {TransportLog} from "./TransportLog"

// at 120 bpm a quarter note is half a second
const log = () => new TransportLog(new ConstantTempoMap(new DefaultObservableValue(120)))
const anchor = (kind: TransportAnchor["kind"], contextTime: number, position: number): TransportAnchor =>
    ({kind, contextTime, position, recording: true})

describe("TransportLog", () => {
    it("knows no position before the first anchor", () => {
        const transport = log()
        transport.append(anchor("start", 1.0, 0))
        expect(transport.positionAt(0.5).isEmpty()).toBe(true)
    })

    it("extrapolates from the last anchor with the tempo map", () => {
        const transport = log()
        transport.append(anchor("start", 1.0, PPQN.Bar))
        expect(transport.positionAt(1.5).unwrap()).toBe(PPQN.Bar + PPQN.Quarter)
    })

    it("places a time before a loop wrap on the old lap and after it on the new one", () => {
        const transport = log()
        transport.append(anchor("start", 1.0, 0))
        transport.append(anchor("jump", 3.0, 0))
        expect(transport.positionAt(2.75).unwrap()).toBe(PPQN.Bar - PPQN.SemiQuaver * 2)
        expect(transport.positionAt(3.25).unwrap()).toBe(PPQN.Quarter / 2)
    })

    it("holds the position after a stop", () => {
        const transport = log()
        transport.append(anchor("start", 1.0, 0))
        transport.append(anchor("stop", 2.0, PPQN.Bar / 2))
        expect(transport.positionAt(5.0).unwrap()).toBe(PPQN.Bar / 2)
    })

    it("sorts an anchor that arrives late into place", () => {
        const transport = log()
        transport.append(anchor("start", 1.0, 0))
        transport.append(anchor("jump", 4.0, 0))
        transport.append(anchor("jump", 3.0, 0))
        expect(transport.anchors.map(({contextTime}) => contextTime)).toEqual([1.0, 3.0, 4.0])
    })

    it("sums the musical time moved across loop wraps", () => {
        const transport = log()
        transport.append(anchor("start", 1.0, 0))
        transport.append(anchor("jump", 3.0, 0))
        transport.append(anchor("jump", 5.0, 0))
        expect(transport.advance(2.5, 5.5)).toBe(PPQN.Quarter * 6)
    })

    it("adds nothing while the transport stands still", () => {
        const transport = log()
        transport.append(anchor("start", 1.0, 0))
        transport.append(anchor("stop", 2.0, PPQN.Bar / 2))
        transport.append(anchor("start", 4.0, PPQN.Bar / 2))
        expect(transport.advance(1.5, 4.5)).toBe(PPQN.Quarter * 2)
    })
})
