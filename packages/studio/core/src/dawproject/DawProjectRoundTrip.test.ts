// @vitest-environment node
import {describe, expect, it} from "vitest"
import JSZip from "jszip"
import {asDefined} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {MetaDataSchema} from "@opendaw/lib-dawproject"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {DawProject} from "./DawProject"
import {DawProjectImport} from "./DawProjectImporter"
import {describeProject, loadSkeleton, silentSamples, validate} from "./DawProject.test-helper"

const roundTrip = async (source: ProjectSkeleton) => {
    const samples = silentSamples()
    const {buffer, issues: exportIssues} = await DawProject.encodeWithReport(source, samples, Xml.element({title: "Test"}, MetaDataSchema))
    const zip = await JSZip.loadAsync(buffer)
    const projectXml = await asDefined(zip.file("project.xml")).async("string")
    const metaDataXml = await asDefined(zip.file("metadata.xml")).async("string")
    const decoded = await DawProject.decode(buffer)
    const imported = await DawProjectImport.read(decoded.project, decoded.resources)
    return {projectXml, metaDataXml, exportIssues, readIssues: decoded.issues, imported}
}

describe("DAWproject round trip", () => {
    const fixtures = ["openup.od", "modulators.od", "atstil.od", "80s.od", "breakit.od", "indahouse.od", "audio-bug.od",
        "overlap.od", "all-devices.od", "video.od", "zeitgeist.od", "automation-bug.od", "env-bug.od"]
    it.each(fixtures)("%s comes back the same", async file => {
        const source = await loadSkeleton(file)
        const {projectXml, metaDataXml, exportIssues, readIssues, imported} = await roundTrip(source)
        expect(validate(projectXml, "Project")).toBe("valid")
        expect(validate(metaDataXml, "MetaData")).toBe("valid")
        expect(readIssues).toEqual([])
        expect(imported.issues).toEqual([])
        expect(describeProject(imported.skeleton)).toEqual(describeProject(source))
        expect(exportIssues).toEqual([])
    }, 60_000)
})
