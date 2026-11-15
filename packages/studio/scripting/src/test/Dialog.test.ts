import {describe, expect, it} from "vitest"
import {ScriptRunner} from "../ScriptRunner"
import {createFixture, FakeHost} from "./Fixture"

const context = {sampleRate: 48000, baseFrequency: 440}

describe("showDialog", () => {
    it("returns one value per field under its name and leaves sections out", async () => {
        const {api, host} = createFixture()
        const values = await api.showDialog({
            headline: "Pad",
            fields: {
                name: {type: "text", label: "Name", value: "Zyn"},
                sound: {type: "section", label: "Sound"},
                voices: {type: "number", label: "Voices", value: 32, min: 1, max: 64, step: 1},
                bandwidth: {type: "slider", label: "Bandwidth", value: 45, min: 1, max: 200, mapping: "exp", unit: "ct"},
                zone: {type: "dropdown", label: "Zone", value: 3, options: [{label: "One", value: 1}, {label: "Three", value: 3}]},
                random: {type: "checkbox", label: "Random", value: true}
            }
        })
        expect(values).toEqual({name: "Zyn", voices: 32, bandwidth: 45, zone: 3, random: true})
        // the result is typed from the fields
        const name: string = values!.name
        const zone: 1 | 3 = values!.zone
        const random: boolean = values!.random
        expect([name, zone, random]).toEqual(["Zyn", 3, true])
        expect(host.forms).toHaveLength(1)
        expect(host.forms[0].okText).toBe("Ok")
        expect(host.forms[0].fields.map(field => field.type))
            .toEqual(["text", "section", "number", "slider", "dropdown", "checkbox"])
    })

    it("fills defaults and drops unknown properties", async () => {
        const {api, host} = createFixture()
        await api.showDialog({
            headline: "Pad", okText: "Create",
            fields: {amount: {type: "slider", label: "Amount", value: 0.5, min: 0, max: 1, html: "<b>no</b>"} as never}
        })
        expect(host.forms[0]).toEqual({
            headline: "Pad", okText: "Create",
            fields: [{type: "slider", label: "Amount", value: 0.5, min: 0, max: 1, mapping: "linear", step: undefined, unit: undefined}]
        })
    })

    it("resolves with null when cancelled", async () => {
        const {api, host} = createFixture()
        host.cancelForms = true
        expect(await api.showDialog({headline: "Pad", fields: {on: {type: "checkbox", label: "On", value: false}}})).toBeNull()
    })

    it("lets a script return early on cancel", async () => {
        const host = new FakeHost()
        host.cancelForms = true
        await new ScriptRunner(host).run(`
            const values = await openDAW.showDialog({headline: "Pad", fields: {on: {type: "checkbox", label: "On", value: false}}});
            if (values === null) {return}
            await openDAW.showInfo("Unreachable", "");`, context)
        expect(host.dialogs).toHaveLength(0)
    })

    describe("rejects a bad dialog before it is shown", () => {
        const bad: ReadonlyArray<[string, unknown, RegExp]> = [
            ["no object", "text", /expected an object/],
            ["no headline", {fields: {}}, /headline/],
            ["fields as list", {headline: "A", fields: []}, /fields: expected an object/],
            ["unknown type", {headline: "A", fields: {a: {type: "html", label: "A"}}}, /fields\.a\.type/],
            ["label no string", {headline: "A", fields: {a: {type: "section", label: 3}}}, /fields\.a\.label/],
            ["text value", {headline: "A", fields: {a: {type: "text", label: "A", value: 1}}}, /fields\.a\.value/],
            ["checkbox value", {headline: "A", fields: {a: {type: "checkbox", label: "A", value: 1}}}, /fields\.a\.value/],
            ["number NaN", {headline: "A", fields: {a: {type: "number", label: "A", value: NaN}}}, /NaN/],
            ["number min above max", {headline: "A", fields: {a: {type: "number", label: "A", value: 1, min: 2, max: 1}}}, /below max/],
            ["number below min", {headline: "A", fields: {a: {type: "number", label: "A", value: 0, min: 1}}}, /not within/],
            ["number above max", {headline: "A", fields: {a: {type: "number", label: "A", value: 9, max: 8}}}, /not within/],
            ["step zero", {headline: "A", fields: {a: {type: "number", label: "A", value: 0, step: 0}}}, /step/],
            ["slider without range", {headline: "A", fields: {a: {type: "slider", label: "A", value: 0}}}, /fields\.a\.min/],
            ["slider min equals max", {headline: "A", fields: {a: {type: "slider", label: "A", value: 1, min: 1, max: 1}}}, /below max/],
            ["slider infinite", {headline: "A", fields: {a: {type: "slider", label: "A", value: 1, min: 0, max: Infinity}}}, /finite/],
            ["slider value outside", {headline: "A", fields: {a: {type: "slider", label: "A", value: 2, min: 0, max: 1}}}, /not within/],
            ["slider unknown mapping", {headline: "A", fields: {a: {type: "slider", label: "A", value: 1, min: 0, max: 1, mapping: "log"}}}, /mapping/],
            ["exp from zero", {headline: "A", fields: {a: {type: "slider", label: "A", value: 1, min: 0, max: 1, mapping: "exp"}}}, /above 0/],
            ["int with fractions", {headline: "A", fields: {a: {type: "slider", label: "A", value: 1, min: 0.5, max: 2, mapping: "int"}}}, /whole numbers/],
            ["dropdown without options", {headline: "A", fields: {a: {type: "dropdown", label: "A", value: 1, options: []}}}, /at least one option/],
            ["dropdown option label", {headline: "A", fields: {a: {type: "dropdown", label: "A", value: 1, options: [{label: 1, value: 1}]}}}, /options\[0\]\.label/],
            ["dropdown option value", {headline: "A", fields: {a: {type: "dropdown", label: "A", value: 1, options: [{label: "A", value: true}]}}}, /options\[0\]\.value/],
            ["dropdown value missing", {headline: "A", fields: {a: {type: "dropdown", label: "A", value: 2, options: [{label: "A", value: 1}]}}}, /not the value of an option/],
            ["dropdown value other type", {headline: "A", fields: {a: {type: "dropdown", label: "A", value: "1", options: [{label: "A", value: 1}]}}}, /not the value of an option/],
            ["__proto__ name", {headline: "A", fields: JSON.parse(`{"__proto__": {"type": "section", "label": "A"}}`)}, /__proto__/]
        ]
        bad.forEach(([title, spec, message]) => it(title, async () => {
            const {api, host} = createFixture()
            await expect(api.showDialog(spec as never)).rejects.toThrow(message)
            expect(host.forms).toHaveLength(0)
        }))
    })

    it("accepts the edges of a range and string choices", async () => {
        const {api} = createFixture()
        expect(await api.showDialog({
            headline: "A",
            fields: {
                low: {type: "slider", label: "Low", value: 1, min: 1, max: 2},
                high: {type: "number", label: "High", value: 8, min: 1, max: 8},
                free: {type: "number", label: "Free", value: -1e9},
                shape: {type: "dropdown", label: "Shape", value: "saw", options: [{label: "Sine", value: "sine"}, {label: "Saw", value: "saw"}]}
            }
        })).toEqual({low: 1, high: 8, free: -1e9, shape: "saw"})
    })
})
