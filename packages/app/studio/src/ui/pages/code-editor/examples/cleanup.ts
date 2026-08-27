import {InaccessibleProperty} from "@opendaw/lib-std"
import {Api} from "@opendaw/studio-scripting"

const openDAW: Api = InaccessibleProperty("Not to be executed.")

// Cleanup: tidies the current project and reports what was removed
// - tracks without regions and clips (one track per unit is always kept)
// - muted regions and clips
// - regions starting beyond the project length
// - auxiliary units nothing sends to

if (!await openDAW.hasProject()) {
    await openDAW.showInfo("Cleanup", "No project is open. Create or load one first.")
} else {
    const project = await openDAW.getProject()
    const report: string[] = []
    const note = (amount: number, what: string) => {if (amount > 0) {report.push(`${amount} × ${what}`)}}

    // Muted content and regions beyond the end
    let mutedRegions = 0
    let mutedClips = 0
    let beyondEnd = 0
    project.audioUnits.forEach(unit => unit.tracks.forEach(track => {
        track.regions.filter(region => region.mute).forEach(region => {
            region.remove()
            mutedRegions++
        })
        track.clips.filter(clip => clip.mute).forEach(clip => {
            clip.remove()
            mutedClips++
        })
        track.regions.filter(region => region.position >= project.duration).forEach(region => {
            region.remove()
            beyondEnd++
        })
    }))
    note(mutedRegions, "muted regions")
    note(mutedClips, "muted clips")
    note(beyondEnd, "regions beyond the project end")

    // Empty tracks, keeping the first one of every unit
    let emptyTracks = 0
    project.audioUnits.forEach(unit => {
        const empty = unit.tracks.filter(track => track.regions.length === 0 && track.clips.length === 0)
        const removable = empty.length === unit.tracks.length ? empty.slice(1) : empty
        removable.forEach(track => {
            track.remove()
            emptyTracks++
        })
    })
    note(emptyTracks, "empty tracks")

    // Auxiliary units without a single send
    const targets = new Set<string>()
    project.audioUnits.forEach(unit => {
        if (unit.kind !== "output") {unit.sends.forEach(send => targets.add(send.target.uuid))}
    })
    const unused = project.auxUnits.filter(aux => !targets.has(aux.uuid))
    unused.forEach(aux => aux.remove())
    note(unused.length, "unused auxiliary units")

    if (report.length === 0) {
        await openDAW.showInfo("Cleanup", `${project.name} is already tidy. Nothing to remove.`)
    } else {
        await openDAW.showInfo("Cleanup", `Removed from ${project.name}:\n\n${report.join("\n")}`)
        project.openInStudio()
    }
}
