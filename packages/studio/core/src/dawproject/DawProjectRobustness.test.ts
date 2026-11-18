// @vitest-environment node
import {describe, expect, it} from "vitest"
import {asInstanceOf, Class, isInstanceOf, Option, Terminable, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {Xml} from "@opendaw/lib-xml"
import {MetaDataSchema, ProjectSchema} from "@opendaw/lib-dawproject"
import {PPQN} from "@opendaw/lib-dsp"
import {AudioRegionBox, AudioFileBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, SampleLoader, SampleLoaderManager} from "@opendaw/studio-adapters"
import {DawProject} from "./DawProject"
import {DawProjectImport} from "./DawProjectImporter"
import {buildProject} from "./DawProject.test-helper"

const noResources: DawProject.ResourceProvider = {
    fromPath: () => {throw new Error("no resources")},
    fromUUID: () => {throw new Error("no resources")}
}

const project = (tracks: string, lanes: string, application: string = `<Application name="Other DAW" version="1"/>`) => `
<Project version="1.0">
    ${application}
    <Structure>
        ${tracks}
        <Track id="master" contentType="audio notes"><Channel id="master-channel" role="master"/></Track>
    </Structure>
    <Arrangement><Lanes timeUnit="beats">${lanes}</Lanes></Arrangement>
</Project>`

const notesTrack = `<Track id="t" name="Keys" contentType="notes"><Channel id="c" role="regular" destination="master-channel"/></Track>`

const importXml = async (xml: string) => {
    const {value, issues: readIssues} = Xml.read(xml, ProjectSchema)
    const result = await DawProjectImport.read(value, noResources)
    return {...result, readIssues}
}

const boxesOf = <T extends Box>(skeleton: ProjectSkeleton, clazz: Class<T>): ReadonlyArray<T> =>
    skeleton.boxGraph.boxes().filter((box): box is T => isInstanceOf(box, clazz))

const notesOf = (region: NoteRegionBox) => asInstanceOf(region.events.targetVertex.unwrap().box, NoteEventCollectionBox)
    .events.pointerHub.incoming().map(({box}) => asInstanceOf(box, NoteEventBox).position.getValue()).sort((left, right) => left - right)

describe("DAWproject import of files from other applications", () => {
    it("reads clips that share notes with different loop starts", async () => {
        const {skeleton} = await importXml(project(notesTrack, `
            <Lanes track="t"><Clips>
                <Clip time="0" duration="4" loopStart="0" loopEnd="4"><Notes id="shared"><Note time="2" duration="1" channel="0" key="60"/></Notes></Clip>
                <Clip time="8" duration="4" loopStart="2" loopEnd="6" reference="shared"/>
            </Clips></Lanes>`))
        const regions = [...boxesOf(skeleton, NoteRegionBox)].sort((left, right) => left.position.getValue() - right.position.getValue())
        expect(regions.map(notesOf)).toEqual([[2 * PPQN.Quarter], [0]])
    })

    it("keeps the note clips of a lane that also holds audio clips", async () => {
        const {skeleton, issues} = await importXml(project(notesTrack, `
            <Lanes track="t"><Clips>
                <Clip time="0" duration="4"><Audio duration="1" channels="2" sampleRate="44100"><File path="missing.wav"/></Audio></Clip>
                <Clip time="4" duration="4"><Notes><Note time="0" duration="1" channel="0" key="60"/></Notes></Clip>
            </Clips></Lanes>`))
        expect(boxesOf(skeleton, NoteRegionBox)).toHaveLength(1)
        expect(issues).toContain("'Keys' cannot play audio, those clips were skipped.")
    })

    it("imports a file with values outside of the schema and reports them", async () => {
        const xml = `<Project version="1.0">
            <Structure>
                <Track id="t" name="Keys" contentType="notes" loaded="True">
                    <Channel id="c" role="aux" audioChannels="2.0"><Volume unit="linear" value=""/></Channel>
                </Track>
            </Structure>
        </Project>`
        const {skeleton, readIssues} = await importXml(xml)
        expect(readIssues).toEqual([
            "Project/Structure/Track/Channel@role: 'aux' is not one of regular, master, effect, submix, vca",
            "Project/Structure/Track/Channel/Volume@value: '' is not a number",
            "Project: missing element 'application'"
        ])
        expect(skeleton.boxGraph.boxes().length).toBeGreaterThan(0)
    })

    it("skips audio clips without a loop length", async () => {
        const audioTrack = `<Track id="t" name="Loops" contentType="audio"><Channel id="c" role="regular" destination="master-channel"/></Track>`
        const decoded = {
            fromPath: (path: string): DawProject.Resource => ({uuid: UUID.generate(), path, name: "loop.wav", buffer: new ArrayBuffer(8)}),
            fromUUID: () => {throw new Error("no resources")}
        }
        const {value} = Xml.read(project(audioTrack, `
            <Lanes track="t"><Clips>
                <Clip time="0" duration="4" contentTimeUnit="seconds" loopStart="1" loopEnd="1"><Audio duration="2" channels="2" sampleRate="44100"><File path="loop.wav"/></Audio></Clip>
            </Clips></Lanes>`), ProjectSchema)
        const {skeleton, issues} = await DawProjectImport.read(value, decoded)
        expect(boxesOf(skeleton, AudioRegionBox)).toHaveLength(0)
        expect(issues).toContain("Clip '' has no loop length and was skipped.")
    })
})

describe("DAWproject export of projects with samples that are not loaded", () => {
    it("finishes and names them", async () => {
        const waiting: SampleLoaderManager = {
            record: () => {},
            remove: () => {},
            invalidate: () => {},
            register: () => Terminable.Empty,
            getOrCreate: (uuid: UUID.Bytes): SampleLoader => ({
                uuid, data: Option.None, peaks: Option.None, meta: Option.None,
                state: {type: "progress", progress: 0.5},
                invalidate: () => {},
                subscribe: () => Terminable.Empty
            })
        }
        const skeleton = buildProject()
        const {issues} = await DawProject.encodeWithReport(skeleton, waiting, Xml.element({}, MetaDataSchema))
        const names = boxesOf(skeleton, AudioFileBox).map(box => box.fileName.getValue())
        expect(issues).toEqual(names.map(name => `Sample '${name}' is not loaded and could not be exported.`))
    })
})
