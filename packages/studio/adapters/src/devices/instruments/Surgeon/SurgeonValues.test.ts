import {describe, expect, it} from "vitest"
import {isDefined} from "@opendaw/lib-std"
import {Surgeon} from "../SurgeonDeviceBoxAdapter"
import {SurgeonModel} from "./SurgeonModel"

describe("Surgeon box values and the loop model", () => {
    it("has one distinct box key for every value", () => {
        const keys = Surgeon.All.map(({key}) => key)
        expect(keys.length).toBe(103)
        expect(new Set(keys).size).toBe(103)
    })
    it("lists the sound parameters in the order of the model", () => {
        expect(Surgeon.Sound.length).toBe(SurgeonModel.Params.length)
        Surgeon.Sound.forEach(({mapping, choices}, index) => {
            const {min, max, choices: modelChoices} = SurgeonModel.Params[index]
            expect(choices?.length).toBe(modelChoices?.length)
            if (!isDefined(choices)) {
                expect(mapping.y(0.0)).toBeCloseTo(min, 6)
                expect(mapping.y(1.0)).toBeCloseTo(max, 6)
                expect(mapping.y(0.37)).toBeCloseTo(SurgeonModel.valueOf(SurgeonModel.Params[index], 0.37), 5)
            }
        })
    })
    it("carries a pattern through the box values and back", () => {
        for (const seed of [1, 5, 12, 77]) {
            const model = SurgeonModel.rollAll({...SurgeonModel.favourite(), restart: seed * 3, offset: 4 - seed}, seed)
            const values = new Map(Surgeon.valuesOf(model))
            expect(values.size).toBe(103)
            const back = Surgeon.modelOf({get: key => values.get(key) ?? Number.NaN})
            expect(back.rate).toBe(model.rate)
            expect(back.restart).toBe(model.restart)
            expect(back.offset).toBe(model.offset)
            expect(back.pitch).toEqual(model.pitch)
            expect(back.lanes).toEqual(model.lanes)
            expect(back.amounts).toEqual(model.amounts)
            back.base.forEach((position, index) => {
                const {choices} = SurgeonModel.Params[index]
                if (isDefined(choices)) {
                    expect(Math.floor(position * choices.length)).toBe(Math.min(Math.floor(model.base[index] * choices.length), choices.length - 1))
                } else {
                    expect(position).toBeCloseTo(model.base[index], 5)
                }
            })
        }
    })
    it("reads the loops through Restart and Offset as the engine does", () => {
        const pattern = (restart: number, offset: number) => ({...SurgeonModel.favourite(), restart, offset})
        const plain = pattern(0, 0)
        for (let step = 0; step < 500; step++) {
            const {position, passes} = SurgeonModel.phase(plain, step).unwrap()
            expect(position).toBe(step)
            expect(passes).toEqual([plain.pitch.steps, ...plain.lanes.map(lane => lane.steps)].map(steps => Math.floor(step / steps)))
            expect(SurgeonModel.stepAt(plain.pitch, position % plain.pitch.steps, passes[0])).toEqual(SurgeonModel.step(plain.pitch, step))
        }
        expect(SurgeonModel.phase(plain, -1).isEmpty()).toBe(true)
        const restarting = pattern(16, 0)
        let last = [0, 0, 0, 0, 0]
        for (let step = 0; step < 640; step++) {
            const {position, passes} = SurgeonModel.phase(restarting, step).unwrap()
            expect(position).toBe(step % 16)
            passes.forEach((pass, index) => {
                expect(pass).toBeGreaterThanOrEqual(last[index])
                if (step % 16 === 0 && step > 0) {expect(pass).toBeGreaterThan(last[index])}
            })
            last = passes.slice()
        }
        expect(SurgeonModel.phase(pattern(0, 3), 0).unwrap().position).toBe(3)
        expect(SurgeonModel.phase(pattern(0, -3), 2).isEmpty()).toBe(true)
        expect(SurgeonModel.phase(pattern(0, -3), 3).unwrap().position).toBe(0)
        expect(SurgeonModel.phase(pattern(16, -3), 0).unwrap().position).toBe(13)
        expect(SurgeonModel.phase(pattern(16, 20), 0).unwrap().position).toBe(4)
        expect(SurgeonModel.phase(pattern(1000, 1000), 0).unwrap()).toEqual(SurgeonModel.phase(pattern(256, 128), 0).unwrap())
    })
})
