import {describe, expect, it} from "vitest"
import {isInstanceOf, panic} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {FileReferenceSchema, ProjectSchema, RealPointSchema} from "@opendaw/lib-dawproject"
import {PPQN} from "@opendaw/lib-dsp"
import {ValueEventBox} from "@opendaw/studio-boxes"
import {SampleLoaderManager} from "@opendaw/studio-adapters"
import {DawProject} from "./DawProject"
import {DawProjectImport} from "./DawProjectImporter"
import {DawProjectExporter} from "./DawProjectExporter"

// tempo automation values are BPM in both openDAW and DAWproject (#484)
describe("DawProject tempo automation", () => {
    const noResources: DawProject.ResourceProvider = {
        fromPath: () => panic("No resources"),
        fromUUID: () => panic("No resources")
    }
    const noSamples: SampleLoaderManager = {
        record: () => panic("No samples"),
        getOrCreate: () => panic("No samples"),
        remove: () => panic("No samples"),
        invalidate: () => panic("No samples"),
        register: () => panic("No samples")
    }
    const projectXml = (points: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Project version="1.0">
        <Transport>
            <Tempo max="666.0" min="20.0" unit="bpm" value="120.0" id="tempo"/>
            <TimeSignature denominator="4" numerator="4" id="signature"/>
        </Transport>
        <Structure>
            <Track contentType="audio notes" loaded="true" id="master-track" name="Master">
                <Channel audioChannels="2" role="master" solo="false" id="master-channel">
                    <Volume max="2.0" min="0.0" unit="linear" value="1.0" id="master-volume" name="Volume"/>
                </Channel>
            </Track>
        </Structure>
        <Arrangement id="arrangement">
            <TempoAutomation unit="bpm">
                <Target parameter="tempo"/>
                ${points}
            </TempoAutomation>
            <Lanes timeUnit="beats" id="lanes"/>
        </Arrangement>
    </Project>`
    const importEvents = async (points: string) => {
        const {skeleton} = await DawProjectImport.read(Xml.parse(projectXml(points), ProjectSchema), noResources)
        const events = skeleton.boxGraph.boxes()
            .filter((box): box is ValueEventBox => box instanceof ValueEventBox)
            .map(box => ({position: box.position.getValue(), value: box.value.getValue()}))
            .sort((a, b) => a.position - b.position)
        return {skeleton, events}
    }
    const threePoints = `
        <RealPoint time="0.0" value="120.0" interpolation="linear"/>
        <RealPoint time="4.0" value="140.0" interpolation="linear"/>
        <RealPoint time="8.0" value="100.0" interpolation="hold"/>`

    it("imports BPM values as they are", async () => {
        const {events} = await importEvents(threePoints)
        expect(events).toEqual([
            {position: 0, value: 120},
            {position: 4 * PPQN.Quarter, value: 140},
            {position: 8 * PPQN.Quarter, value: 100}
        ])
    })

    it("clamps imported BPM values to the tempo range", async () => {
        const {events} = await importEvents(`
            <RealPoint time="0.0" value="5.0" interpolation="linear"/>
            <RealPoint time="4.0" value="5000.0" interpolation="linear"/>`)
        expect(events.map(({value}) => value)).toEqual([30, 1000])
    })

    it("exports BPM values as they are", async () => {
        const {skeleton} = await importEvents(threePoints)
        skeleton.boxGraph.beginTransaction()
        skeleton.mandatoryBoxes.timelineBox.tempoTrack.minBpm.setValue(30)
        skeleton.mandatoryBoxes.timelineBox.tempoTrack.maxBpm.setValue(300)
        skeleton.boxGraph.endTransaction()
        const schema = DawProjectExporter.write(skeleton, noSamples, {
            write: (path: string): FileReferenceSchema => Xml.element({path, external: false}, FileReferenceSchema)
        })
        const exported = Xml.parse(Xml.pretty(Xml.toElement("Project", schema)), ProjectSchema)
        const points = (exported.arrangement?.tempoAutomation?.points ?? [])
            .filter((point): point is RealPointSchema => isInstanceOf(point, RealPointSchema))
            .map(({time, value}) => ({time: Number(time), value: Number(value)}))
        expect(points).toEqual([{time: 0, value: 120}, {time: 4, value: 140}, {time: 8, value: 100}])
    })
})
