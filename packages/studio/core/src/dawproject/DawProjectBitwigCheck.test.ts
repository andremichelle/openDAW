// @vitest-environment node
// Runs only from scripts/dawproject-bitwig.sh: writes the test exports for Bitwig Studio, then checks its re-exports.
import {describe, expect, it} from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import {asInstanceOf, isDefined, isInstanceOf} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {MetaDataSchema} from "@opendaw/lib-dawproject"
import {PPQN} from "@opendaw/lib-dsp"
import {AudioUnitBox, MarkerBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {DawProject} from "./DawProject"
import {DawProjectImport} from "./DawProjectImporter"
import {buildProject, describeProject, loadSkeleton, silentSamples} from "./DawProject.test-helper"

const exportDirectory = process.env.DAWPROJECT_EXPORT_DIR
const bitwigDirectory = process.env.DAWPROJECT_BITWIG_DIR
const fixtures = ["openup.od", "modulators.od", "atstil.od", "80s.od", "breakit.od", "indahouse.od", "overlap.od",
    "all-devices.od", "video.od", "zeitgeist.od"]

const sources = async (): Promise<ReadonlyArray<[string, ProjectSkeleton]>> => [
    ...await Promise.all(fixtures.map(async (file): Promise<[string, ProjectSkeleton]> =>
        [file.replace(/\.od$/, ""), await loadSkeleton(file)])),
    ["features", buildProject()]
]

// what Bitwig keeps of an openDAW project: the mixer, the arrangement and the timeline, not openDAW's devices
const bitwigView = (skeleton: ProjectSkeleton) => {
    const round = (value: number) => Math.round(value * 1000) / 1000
    const {units, bpm, signature, tempoEvents} = describeProject(skeleton)
    return {
        bpm: round(bpm), signature, tempoEvents: tempoEvents.map(({position, value}) => [position, round(value)]),
        markers: skeleton.boxGraph.boxes().filter(box => isInstanceOf(box, MarkerBox))
            .map(box => asInstanceOf(box, MarkerBox)).map(marker => marker.position.getValue()).sort((left, right) => left - right),
        units: units.map(unit => ({
            type: unit.type, volume: round(unit.volume), panning: round(unit.panning), mute: unit.mute, solo: unit.solo,
            sends: unit.sends.map(send => ({routing: send.routing, gain: round(send.gain), pan: round(send.pan)})),
            regions: unit.tracks.flatMap(track => track.regions).map(region => ({
                kind: region.kind, position: region.position,
                duration: round(region.kind === "audio" && region.timeBase === "seconds" ? region.duration : region.duration / PPQN.Quarter),
                notes: region.kind === "notes"
                    ? region.content.notes.map(note => [note.position, note.duration, note.pitch, round(note.velocity)]) : []
            })).sort((left, right) => left.position - right.position || left.kind.localeCompare(right.kind))
        }))
    }
}

describe.runIf(isDefined(exportDirectory))("DAWproject exports for Bitwig Studio", () => {
    it("writes every test project", async () => {
        const directory = exportDirectory ?? ""
        fs.mkdirSync(directory, {recursive: true})
        for (const [name, skeleton] of await sources()) {
            const {buffer, issues} = await DawProject.encodeWithReport(skeleton, silentSamples(),
                Xml.element({title: name}, MetaDataSchema))
            fs.writeFileSync(path.join(directory, `${name}.dawproject`), new Uint8Array(buffer))
            if (issues.length > 0) {console.info(name, issues)}
        }
    }, 120_000)
})

describe.runIf(isDefined(bitwigDirectory))("DAWproject re-exports of Bitwig Studio", () => {
    it("keeps the mixer, the arrangement and the timeline", async () => {
        const directory = bitwigDirectory ?? ""
        const results: Array<string> = []
        for (const [name, source] of await sources()) {
            const file = path.join(directory, `${name}.dawproject`)
            if (!fs.existsSync(file)) {
                results.push(`${name}: no re-export found`)
                continue
            }
            const decoded = await DawProject.decode(fs.readFileSync(file))
            const {skeleton, issues} = await DawProjectImport.read(decoded.project, decoded.resources)
            const units = (box: ProjectSkeleton) => box.boxGraph.boxes().filter(unit => isInstanceOf(unit, AudioUnitBox)).length
            const same = JSON.stringify(bitwigView(skeleton)) === JSON.stringify(bitwigView(source))
            results.push(`${name}: ${same ? "same" : "differs"}, ${units(skeleton)} of ${units(source)} units, ${issues.length} import notes`)
            if (!same) {
                fs.writeFileSync(path.join(directory, `${name}.expected.json`), JSON.stringify(bitwigView(source), null, 2))
                fs.writeFileSync(path.join(directory, `${name}.received.json`), JSON.stringify(bitwigView(skeleton), null, 2))
            }
        }
        console.info(results.join("\n"))
        expect(results.every(result => result.includes(": same"))).toBe(true)
    }, 120_000)
})
