import {it, expect} from "vitest"
import {readFileSync} from "node:fs"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {AudioUnitGroups} from "./AudioUnitGroups"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {asInstanceOf, UUID} from "@opendaw/lib-std"

// Synthetic project saved by the old two-pointer folder implementation, before schema removal.
// One member follows the group route; another had independent membership and bypassed it.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/legacy-folder-project.json", import.meta.url), "utf8"))

it("loads an old folder project using its preserved routes, then saves without legacy membership fields", () => {
    const project = ProjectSkeleton.decode(Uint8Array.from(Buffer.from(fixture.project, "base64")).buffer)
    const check = (skeleton: ProjectSkeleton) => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
        const unit = (uuid: string) => asInstanceOf(boxGraph.findBox(UUID.parse(uuid)).unwrap(), AudioUnitBox)
        const group = unit(fixture.group), member = unit(fixture.member), bypass = unit(fixture.bypass)
        expect(group.isGroup.getValue()).toBe(true)
        expect(group.groupCollapsed.getValue()).toBe(true)
        expect(group.userInterface.height.getValue()).toBe(108)
        expect(AudioUnitGroups.parent(member).unwrapOrUndefined()).toBe(group)
        expect(AudioUnitGroups.children(rootBox, group)).toEqual([member])
        expect(member.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(group).unwrapOrUndefined())
        expect(AudioUnitGroups.parent(bypass).unwrapOrUndefined()).toBeUndefined()
        expect(bypass.output.targetVertex.unwrap().box).toBe(primaryAudioBusBox)
        expect(AudioUnitGroups.hidden(member)).toBe(true)
        expect(AudioUnitGroups.hidden(bypass)).toBe(false)
        expect(Reflect.has(group, "groupParent")).toBe(false)
        expect(Reflect.has(group, "groupChildren")).toBe(false)
        boxGraph.verifyPointers()
    }
    check(project)
    check(ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph)))
})
