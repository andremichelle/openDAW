import {describe, expect, it} from "vitest"
import {isDefined} from "@opendaw/lib-std"
import {Surgeon} from "../SurgeonDeviceBoxAdapter"
import {SurgeonModel} from "./SurgeonModel"

describe("Surgeon box values and the loop model", () => {
    it("has one distinct box key for every value", () => {
        const keys = Surgeon.All.map(({key}) => key)
        expect(keys.length).toBe(101)
        expect(new Set(keys).size).toBe(101)
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
            const model = SurgeonModel.rollAll(SurgeonModel.favourite(), seed)
            const values = new Map(Surgeon.valuesOf(model))
            expect(values.size).toBe(101)
            const back = Surgeon.modelOf({get: key => values.get(key) ?? Number.NaN})
            expect(back.rate).toBe(model.rate)
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
})
