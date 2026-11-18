// @vitest-environment node
import {describe, expect, it} from "vitest"
import JSZip from "jszip"
import {asDefined, asInstanceOf, isInstanceOf} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {ClapPreset, MetaDataSchema, ProjectSchema} from "@opendaw/lib-dawproject"
import {AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {DawProject} from "./DawProject"
import {DawProjectImport} from "./DawProjectImporter"
import {buildProject, describeProject, silentSamples, validate} from "./DawProject.test-helper"

const exportAndImport = async (skeleton: ProjectSkeleton) => {
    const {buffer, issues} = await DawProject.encodeWithReport(skeleton, silentSamples(), Xml.element({title: "Features"}, MetaDataSchema))
    const zip = await JSZip.loadAsync(buffer)
    const decoded = await DawProject.decode(buffer)
    const imported = await DawProjectImport.read(decoded.project, decoded.resources)
    return {zip, exportIssues: issues, readIssues: decoded.issues, imported, xml: await asDefined(zip.file("project.xml")).async("string")}
}

describe("DAWproject features", () => {
    it("every feature comes back the same and the export is schema valid", async () => {
        const source = buildProject()
        const {xml, exportIssues, readIssues, imported} = await exportAndImport(source)
        expect(validate(xml, "Project")).toBe("valid")
        expect(exportIssues).toEqual([])
        expect(readIssues).toEqual([])
        expect(imported.issues).toEqual([])
        expect(describeProject(imported.skeleton)).toEqual(describeProject(source))
    })

    it("writes mirrored regions once and refers to them", async () => {
        const {xml} = await exportAndImport(buildProject())
        expect(xml.match(/<Notes /g)?.length).toBe(1)
        expect(xml.match(/reference="_/g)?.length).toBe(3)
    })

    it("writes what other applications read", async () => {
        const {xml, zip} = await exportAndImport(buildProject())
        expect(xml).toContain(`<Application name="openDAW"`)
        expect(xml).toContain(`role="submix"`)
        expect(xml).toContain(`role="effect"`)
        expect(xml).toContain(`<Send `)
        expect(xml).toContain(`type="pre"`)
        expect(xml).toMatch(/<ClapPlugin [^>]*deviceID="org.surge-synth-team.surge-xt"/)
        expect(xml).toMatch(/<RealParameter [^>]*parameterID="1243907205" max="2" min="0" unit="normalized" value="0.625"\/>/)
        expect(xml).toContain(`expression="transpose"`)
        expect(xml).toMatch(/<BoolPoint time="4" value="true"\/>/)
        expect(xml).toMatch(/<Marker name="Intro" color="#[0-9a-f]{6}" time="0"\/>/)
        expect(xml).toContain(`name="Drop &amp; &lt;Build&gt;"`)
        expect(xml).toMatch(/<TimeSignaturePoint time="6" numerator="7" denominator="8"\/>/)
        const preset = Object.keys(zip.files).find(name => name.endsWith(".clap-preset"))
        const decoded = ClapPreset.decode(await asDefined(zip.file(asDefined(preset))).async("arraybuffer")).unwrap()
        expect(decoded.pluginId).toBe("org.surge-synth-team.surge-xt")
        expect(Array.from(decoded.state)).toEqual([1, 2, 3, 255])
        expect(Object.keys(zip.files).filter(name => name.endsWith(".clap-preset.opendaw"))).toHaveLength(1)
        expect(Object.keys(zip.files).some(name => /^samples\/[0-9a-f-]{36}\/Loop 01\.wav$/.test(name))).toBe(true)
    })

    it("an export of the import is the same export", async () => {
        const first = await exportAndImport(buildProject())
        const second = await exportAndImport(first.imported.skeleton)
        expect(describeProject(second.imported.skeleton)).toEqual(describeProject(first.imported.skeleton))
        expect(second.xml.replace(/id\d+/g, "id")).toBe(first.xml.replace(/id\d+/g, "id"))
    })

    it("keeps working without a primary output in the file", async () => {
        const xml = `<Project version="1.0"><Application name="x" version="1"/><Structure><Track id="t" contentType="notes"><Channel id="c" role="regular"/></Track></Structure></Project>`
        const {skeleton} = await DawProjectImport.read(Xml.parse(xml, ProjectSchema), {
            fromPath: () => {throw new Error("none")},
            fromUUID: () => {throw new Error("none")}
        })
        const units = skeleton.boxGraph.boxes().filter(box => isInstanceOf(box, AudioUnitBox)).map(box => asInstanceOf(box, AudioUnitBox))
        expect(units.map(unit => unit.type.getValue()).sort()).toEqual([AudioUnitType.Instrument, AudioUnitType.Output])
        const instrument = asDefined(units.find(unit => unit.type.getValue() === AudioUnitType.Instrument))
        expect(instrument.output.targetVertex.unwrap().box).toBe(skeleton.mandatoryBoxes.primaryAudioBusBox)
    })
})
