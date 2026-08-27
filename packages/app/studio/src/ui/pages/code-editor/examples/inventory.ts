import {InaccessibleProperty} from "@opendaw/lib-std"
import {AnyAudioEffect, Api, AudioEffectCompositeEntry, AudioEffectHost, MIDIEffectHost} from "@opendaw/studio-scripting"

const openDAW: Api = InaccessibleProperty("Not to be executed.")

// Inventory: reads the project currently open in the studio, counts everything in it and shows the result

if (!await openDAW.hasProject()) {
    await openDAW.showInfo("Inventory", "No project is open. Create or load one first.")
} else {
    const project = await openDAW.getProject()
    const count = new Map<string, number>()
    const add = (name: string, amount: number = 1) => count.set(name, (count.get(name) ?? 0) + amount)

    const entriesOf = (effect: AnyAudioEffect): ReadonlyArray<AudioEffectCompositeEntry> =>
        effect.key === "Composite" || effect.key === "StereoSplit" || effect.key === "FrequencySplit" ? effect.entries : []

    const countHost = (owner: string, host: AudioEffectHost & Partial<MIDIEffectHost>) => {
        host.midiEffects?.forEach(effect => add(`${owner} MIDI effect ${effect.key}`))
        host.audioEffects.forEach(effect => {
            add(`${owner} audio effect ${effect.key}`)
            const entries = entriesOf(effect)
            add("composite entries", entries.length)
            entries.forEach(entry => countHost("composite", entry))
        })
    }

    project.audioUnits.forEach(unit => {
        add(`${unit.kind} units`)
        if (unit.kind === "instrument") {
            add(`instrument ${unit.instrument.key}`)
            if (unit.instrument.key === "Playfield") {
                add("playfield slots", unit.instrument.slots.length)
                unit.instrument.slots.forEach(slot => countHost("playfield slot", slot))
            }
        }
        if (unit.kind !== "output") {add("sends", unit.sends.length)}
        countHost("unit", unit)
        unit.tracks.forEach(track => {
            add(`${track.type} tracks`)
            if (track.type === "notes") {
                add("note regions", track.regions.length)
                add("note clips", track.clips.length)
                track.regions.forEach(region => add("note events", region.events.length))
                track.clips.forEach(clip => add("note events", clip.events.length))
            } else if (track.type === "audio") {
                add("audio regions", track.regions.length)
                add("audio clips", track.clips.length)
            } else {
                add("automation regions", track.regions.length)
                add("automation clips", track.clips.length)
                track.regions.forEach(region => add("automation events", region.events.length))
                track.clips.forEach(clip => add("automation events", clip.events.length))
            }
        })
    })
    add("markers", project.markers.length)
    add("tempo events", project.tempoTrack.events.length)
    add("signature events", project.signatureTrack.events.length)
    project.modulators.forEach(modulator => {
        add(`modulator ${modulator.kind}`)
        add("modulations", modulator.modulations.length)
        add("modulator automation lanes", modulator.valueTracks.length)
    })

    const lines = [
        `${project.name}: ${project.bpm} bpm, ${project.timeSignature.numerator}/${project.timeSignature.denominator}`,
        ""
    ]
    const sorted = [...count.entries()].filter(([, amount]) => amount > 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    sorted.forEach(([name, amount]) => lines.push(`${amount} × ${name}`))
    await openDAW.showInfo("Inventory", lines.join("\n"))
}
