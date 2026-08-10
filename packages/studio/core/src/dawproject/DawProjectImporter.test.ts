import {describe, expect, it} from "vitest"
import {fileURLToPath} from "url"
import * as path from "node:path"
import * as fs from "node:fs"
import {panic} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {ProjectSchema} from "@opendaw/lib-dawproject"
import {LoopableRegion, PPQN} from "@opendaw/lib-dsp"
import {NoteRegionBox} from "@opendaw/studio-boxes"
import {DawProject} from "./DawProject"
import {DawProjectImport} from "./DawProjectImporter"

describe("DawProjectImport", () => {
    it("import", async () => {
        const __dirname = path.dirname(fileURLToPath(import.meta.url))
        const testFile = "../../../../../test-files/eq.dawproject"
        const buffer = fs.readFileSync(path.join(__dirname, testFile))
        const {project, resources} = await DawProject.decode(buffer)
        const {skeleton} = await DawProjectImport.read(project, resources)
    })
})

describe("DawProjectImport loop window", () => {
    const noResources: DawProject.ResourceProvider = {
        fromPath: () => panic("No resources"),
        fromUUID: () => panic("No resources")
    }

    const lane = (trackId: string, laneId: string, clipsId: string, clip: string) => `
        <Lanes track="${trackId}" id="${laneId}">
            <Clips id="${clipsId}">
                ${clip}
                    <Notes id="notes-${clipsId}">
                        <Note time="0.5" duration="0.25" channel="0" key="60" vel="0.8" rel="0.0"/>
                    </Notes>
                </Clip>
            </Clips>
        </Lanes>`

    const track = (trackId: string, channelId: string) => `
        <Track contentType="notes" loaded="true" id="${trackId}" name="${trackId}">
            <Channel audioChannels="2" destination="master-channel" role="regular" solo="false" id="${channelId}">
                <Volume max="2.0" min="0.0" unit="linear" value="1.0" id="volume-${channelId}" name="Volume"/>
            </Channel>
        </Track>`

    const projectXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Project version="1.0">
        <Transport>
            <Tempo max="666.0" min="20.0" unit="bpm" value="120.0" id="tempo"/>
            <TimeSignature denominator="4" numerator="4" id="signature"/>
        </Transport>
        <Structure>
            ${track("beyond-content", "channel-0")}
            ${track("offset-content", "channel-1")}
            ${track("looped-content", "channel-2")}
            <Track contentType="audio notes" loaded="true" id="master-track" name="Master">
                <Channel audioChannels="2" role="master" solo="false" id="master-channel">
                    <Volume max="2.0" min="0.0" unit="linear" value="1.0" id="master-volume" name="Volume"/>
                </Channel>
            </Track>
        </Structure>
        <Arrangement id="arrangement">
            <Lanes timeUnit="beats" id="lanes">
                ${lane("beyond-content", "lane-0", "clips-0",
        `<Clip time="128.0" duration="64.0" playStart="68.0" enable="true">`)}
                ${lane("offset-content", "lane-1", "clips-1",
        `<Clip time="64.0" duration="64.0" playStart="4.0" enable="true">`)}
                ${lane("looped-content", "lane-2", "clips-2",
        `<Clip time="0.0" duration="4.0" playStart="1.0" loopStart="0.0" loopEnd="2.0" enable="true">`)}
            </Lanes>
        </Arrangement>
    </Project>`

    const readRegions = async () => {
        const schema = Xml.parse(projectXml, ProjectSchema)
        const {skeleton} = await DawProjectImport.read(schema, noResources)
        const regions = skeleton.boxGraph.boxes()
            .filter((box): box is NoteRegionBox => box instanceof NoteRegionBox)
        return regions.map(box => ({
            position: box.position.getValue(),
            duration: box.duration.getValue(),
            loopOffset: box.loopOffset.getValue(),
            loopDuration: box.loopDuration.getValue()
        })).sort((a, b) => a.position - b.position)
    }

    it("playStart beyond the clip duration keeps the loop window positive", async () => {
        const [, , beyond] = await readRegions()
        expect(beyond.position).toBe(128 * PPQN.Quarter)
        expect(beyond.duration).toBe(64 * PPQN.Quarter)
        expect(beyond.loopOffset).toBe(68 * PPQN.Quarter)
        expect(beyond.loopDuration).toBe(132 * PPQN.Quarter)
    })

    it("playStart offsets the content without wrapping it", async () => {
        const [, offset] = await readRegions()
        expect(offset.loopOffset).toBe(4 * PPQN.Quarter)
        expect(offset.loopDuration).toBe(68 * PPQN.Quarter)
    })

    it("loop markers define the loop window", async () => {
        const [looped] = await readRegions()
        expect(looped.loopOffset).toBe(1 * PPQN.Quarter)
        expect(looped.loopDuration).toBe(2 * PPQN.Quarter)
    })

    it("every imported region renders a finite number of loop cycles", async () => {
        for (const region of await readRegions()) {
            const complete = region.position + region.duration
            const cycles = [...LoopableRegion.locateLoops({...region, complete}, 0, 1024 * PPQN.Quarter)]
            expect(cycles.length).toBeGreaterThan(0)
            expect(cycles.length).toBeLessThanOrEqual(Math.ceil(region.duration / region.loopDuration) + 1)
        }
    })
})
