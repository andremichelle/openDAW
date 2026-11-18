// @vitest-environment node
import {describe, expect, it} from "vitest"
import {Xml} from "./Xml"

enum Unit {LINEAR = "linear", BPM = "bpm"}

abstract class NameableSchema {
    @Xml.Attribute("name", Xml.StringOptional) declare readonly name?: string
}

@Xml.Class("RealParameter")
class RealParameterSchema extends NameableSchema {
    @Xml.Attribute("unit", Xml.Enum(Unit, true)) declare readonly unit: Unit
    @Xml.Attribute("value", Xml.NumberOptional) declare readonly value?: number
}

@Xml.Class("Note")
class NoteSchema {
    @Xml.Attribute("time", Xml.NumberRequired) declare readonly time: number
    @Xml.Attribute("key", Xml.IntRequired) declare readonly key: number
}

@Xml.Class("Project")
class ProjectSchema {
    @Xml.Attribute("version", Xml.StringRequired) declare readonly version: string
    @Xml.Text("Title") declare readonly title?: string
    @Xml.Child(() => RealParameterSchema, {name: "Tempo", required: true}) declare readonly tempo: RealParameterSchema
    @Xml.Children(() => NoteSchema, {wrapper: "Notes"}) declare readonly notes: ReadonlyArray<NoteSchema>
}

describe("README", () => {
    it("writes and reads the documented example", () => {
        const project = Xml.element({
            version: "1.0",
            title: "Demo",
            tempo: Xml.element({name: "Tempo", unit: Unit.BPM, value: 120}, RealParameterSchema),
            notes: [Xml.element({time: 0, key: 60}, NoteSchema)]
        }, ProjectSchema)
        const xml = Xml.write(project)
        expect(xml).toBe([
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
            `<Project version="1.0">`,
            `  <Title>Demo</Title>`,
            `  <Tempo name="Tempo" unit="bpm" value="120"/>`,
            `  <Notes>`,
            `    <Note time="0" key="60"/>`,
            `  </Notes>`,
            `</Project>`
        ].join("\n"))
        const {value, issues} = Xml.read(xml, ProjectSchema)
        expect(issues).toEqual([])
        expect(value.tempo.value).toBe(120)
        expect(value.notes[0].key).toBe(60)
    })
})
