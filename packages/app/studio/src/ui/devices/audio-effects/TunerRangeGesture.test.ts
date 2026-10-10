import {describe, expect, it} from "vitest"
import {BoxEditing} from "@opendaw/lib-box"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, TunerDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {TunerRangeGesture} from "./TunerRangeGesture"
import {TunerViewState} from "./TunerViewState"

describe("tuner range gesture", () => {
    it("previews all movements and commits pan, zoom and Manual in a single undo step", () => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        boxGraph.beginTransaction()
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
        })
        const box = TunerDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.audioEffects))
        boxGraph.endTransaction()
        const editing = new BoxEditing(boxGraph)
        const state = new TunerViewState(69, 6)
        const gesture = new TunerRangeGesture(state, 480, 240, range => editing.modify(() => {
            box.historyCenter.setValue(range.center)
            box.historySpan.setValue(range.span)
            box.autoFollow.setValue(false)
        }))
        for (const displacement of [10, 20, 30, 40]) {gesture.move(displacement, displacement)}
        state.update(0, true, 440, true, {center: 69, span: 6})
        expect(state.center).toBeGreaterThan(69)
        expect(state.span).toBeGreaterThan(6)
        expect(box.historyCenter.getValue()).toBe(69)
        expect(editing.canUndo()).toBe(false)
        gesture.approve()
        expect(box.historyCenter.getValue()).toBeCloseTo(state.center)
        expect(box.historySpan.getValue()).toBeCloseTo(state.span)
        expect(box.autoFollow.getValue()).toBe(false)
        expect(editing.undo()).toBe(true)
        expect(editing.canUndo()).toBe(false)
        expect([box.historyCenter.getValue(), box.historySpan.getValue(), box.autoFollow.getValue()]).toEqual([69, 6, true])
        expect(editing.redo()).toBe(true)
        expect(box.historyCenter.getValue()).toBeCloseTo(state.center)
    })
    it("cancels preview without committing and clamps extreme pan/zoom", () => {
        const state = new TunerViewState(69, 6)
        const commits: number[] = []
        const gesture = new TunerRangeGesture(state, 480, 240, range => commits.push(range.center))
        gesture.move(10000, -10000)
        expect(state.preview).toEqual({center: 12, span: 24})
        gesture.cancel()
        expect(state.preview).toBeUndefined()
        expect([state.center, state.span]).toEqual([69, 6])
        expect(commits).toEqual([])
    })
})
