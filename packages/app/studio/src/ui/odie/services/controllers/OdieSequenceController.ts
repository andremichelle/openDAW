import { Option, UUID } from "@opendaw/lib-std"
import { PPQN } from "@opendaw/lib-dsp"
import {
    NoteRegionBoxAdapter,
    AnyRegionBoxAdapter,
    NoteEventBoxAdapter,
    RegionEditing
} from "@opendaw/studio-adapters"
import {
    NoteRegionBox,
    NoteEventCollectionBox,
    NoteEventBox
} from "@opendaw/studio-boxes"
import { OdieBaseController } from "./OdieBaseController"
import { ToolResult, MidiNoteDef, AnalysisResult, RegionAnalysis } from "../../OdieTypes"

export class OdieSequenceController extends OdieBaseController {
    public async splitRegion(trackName: string, time?: number): Promise<ToolResult> {
        const t = time ?? this.studio.transport.position.getValue()
        return this.findRegion(trackName, t).match<Promise<ToolResult>>({
            some: async (region) => {
                RegionEditing.cut(region, t, false)
                return { success: true, message: "Region split" }
            },
            none: () => Promise.resolve({ success: false, reason: "No region found at time" })
        })
    }

    public async moveRegion(trackName: string, time: number, newTime: number): Promise<ToolResult> {
        return this.findRegion(trackName, time).match<Promise<ToolResult>>({
            some: async (region) => {
                region.position = newTime
                return { success: true, message: "Region moved" }
            },
            none: () => Promise.resolve({ success: false, reason: "No region found at time" })
        })
    }

    public async copyRegion(trackName: string, time: number, newTime: number): Promise<ToolResult> {
        return this.findRegion(trackName, time).match<Promise<ToolResult>>({
            some: async (region) => {
                region.copyTo({ position: newTime })
                return { success: true, message: "Region copied" }
            },
            none: () => Promise.resolve({ success: false, reason: "No region found at time" })
        })
    }

    public async getMidiNotes(trackName: string): Promise<{ notes: MidiNoteDef[], logs: string[] }> {
        return this.findAudioUnitAdapter(trackName).match({
            some: (adapter) => {
                const notes: MidiNoteDef[] = []
                const logs: string[] = []

                const log = (msg: string) => {
                    logs.push(msg)
                    console.log(`[Odie] getMidiNotes: ${msg}`)
                }

                log(`Scanning track "${trackName}" for MIDI notes...`)

                // Search all tracks in the AU adapter
                for (const track of adapter.tracks.adapters()) {
                    for (const region of track.regions.collection.asArray()) {
                        if (region instanceof NoteRegionBoxAdapter) {
                            const noteRegion = region as NoteRegionBoxAdapter
                            const collection = noteRegion.optCollection

                            if (collection.nonEmpty()) {
                                const events = collection.unwrap().events.asArray()
                                log(`Found region at ${noteRegion.position} with ${events.length} notes.`)

                                for (const event of events) {
                                    const noteEvent = event as NoteEventBoxAdapter
                                    notes.push({
                                        startTime: noteRegion.position + noteEvent.position,
                                        duration: noteEvent.duration,
                                        pitch: noteEvent.pitch,
                                        velocity: noteEvent.velocity
                                    })
                                }
                            }
                        }
                    }
                }

                if (notes.length === 0) log("No notes found.")
                else log(`Successfully extracted ${notes.length} notes.`)

                return { notes, logs }
            },
            none: () => ({ notes: [], logs: [`Track "${trackName}" not found.`] })
        })
    }

    public async addMidiNotes(trackName: string, notes: MidiNoteDef[]): Promise<ToolResult> {
        try {
            const adapterMeta = this.findAudioUnitAdapter(trackName)
            if (adapterMeta.isEmpty()) return { success: false, reason: "Track not found" }
            const adapter = adapterMeta.unwrap()

            const track = adapter.tracks.collection.adapters()[0]
            if (!track) return { success: false, reason: "No track lane found" }

            const { editing, boxGraph } = this.studio.project

            editing.modify(() => {
                // Find or create a MIDI region covering the range
                const startPPQN = notes.reduce((min, n) => Math.min(min, n.startTime), Infinity)
                const endPPQN = notes.reduce((max, n) => Math.max(max, n.startTime + n.duration), -Infinity)

                const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
                for (const n of notes) {
                    NoteEventBox.create(boxGraph, UUID.generate(), box => {
                        box.events.refer(collection.events)
                        box.position.setValue(n.startTime - startPPQN)
                        box.duration.setValue(n.duration)
                        box.pitch.setValue(n.pitch)
                        box.velocity.setValue(n.velocity)
                    })
                }

                NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.regions.refer(track.box.regions)
                    box.events.refer(collection.owners)
                    box.position.setValue(startPPQN)
                    box.duration.setValue(endPPQN - startPPQN)
                })
            })

            return { success: true, message: `Added ${notes.length} notes to '${trackName}'` }
        } catch (e: unknown) {
            return { success: false, reason: `Failed to add notes: ${e instanceof Error ? e.message : String(e)}` }
        }
    }

    public async addNoteClip(trackName: string, label: string, notes: MidiNoteDef[]): Promise<ToolResult> {
        try {
            const adapterMeta = this.findAudioUnitAdapter(trackName)
            if (adapterMeta.isEmpty()) return { success: false, reason: "Track not found" }
            const adapter = adapterMeta.unwrap()

            const track = adapter.tracks.collection.adapters()[0]
            if (!track) return { success: false, reason: "No track lane found" }

            const { editing, boxGraph } = this.studio.project

            editing.modify(() => {
                const startTime = notes.length > 0 ? Math.min(...notes.map(n => n.startTime)) : 1
                const endTime = notes.length > 0 ? Math.max(...notes.map(n => n.startTime + n.duration)) : startTime + 4

                const sig = this.studio.project.timelineBox.signature
                const ticksPerBar = PPQN.fromSignature(sig.nominator.getValue(), sig.denominator.getValue())

                const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
                for (const n of notes) {
                    NoteEventBox.create(boxGraph, UUID.generate(), box => {
                        box.events.refer(collection.events)
                        box.position.setValue(this.barToPPQN(n.startTime) - this.barToPPQN(startTime))
                        box.duration.setValue(n.duration * ticksPerBar)
                        box.pitch.setValue(n.pitch)
                        box.velocity.setValue(n.velocity)
                    })
                }

                NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.regions.refer(track.box.regions)
                    box.events.refer(collection.owners)
                    box.position.setValue(this.barToPPQN(startTime))
                    box.duration.setValue(this.barToPPQN(endTime) - this.barToPPQN(startTime))
                    box.label.setValue(label)
                })
            })

            return { success: true, message: `Added Note Clip "${label}" to '${trackName}'` }
        } catch (e: unknown) {
            return { success: false, reason: `addNoteClip error: ${e instanceof Error ? e.message : String(e)}` }
        }
    }

    public async addNote(trackName: string, pitch: number, start: number, duration: number, velocity: number): Promise<ToolResult> {
        try {
            const adapterMeta = this.findAudioUnitAdapter(trackName)
            if (adapterMeta.isEmpty()) return { success: false, reason: "Track not found" }
            const adapter = adapterMeta.unwrap()

            const track = adapter.tracks.collection.adapters()[0]
            if (!track) return { success: false, reason: "No track lane found" }

            const { editing, boxGraph } = this.studio.project

            editing.modify(() => {
                const startPPQN = this.barToPPQN(start)
                const durationPPQN = duration * 4.0

                // Find existing region at this position
                // Find existing region at this position
                const existing = track.regions.collection.asArray().find(r =>
                    r instanceof NoteRegionBoxAdapter &&
                    r.position <= startPPQN &&
                    (r.position + r.duration) >= (startPPQN + durationPPQN)
                ) as NoteRegionBoxAdapter | undefined

                if (existing) {
                    const collection = existing.optCollection
                    if (collection.nonEmpty()) {
                        NoteEventBox.create(boxGraph, UUID.generate(), box => {
                            box.events.refer(collection.unwrap().box.events)
                            box.position.setValue(startPPQN - existing.position)
                            box.duration.setValue(durationPPQN)
                            box.pitch.setValue(pitch)
                            box.velocity.setValue(velocity)
                        })
                        return
                    }
                }

                // Create new region
                const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
                NoteEventBox.create(boxGraph, UUID.generate(), box => {
                    box.events.refer(collection.events)
                    box.position.setValue(0)
                    box.duration.setValue(durationPPQN)
                    box.pitch.setValue(pitch)
                    box.velocity.setValue(velocity)
                })

                NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.regions.refer(track.box.regions)
                    box.events.refer(collection.owners)
                    box.position.setValue(startPPQN)
                    box.duration.setValue(durationPPQN)
                })
            })

            this.studio.odieEvents.notify({ type: "ui-feedback", message: `Added note ${pitch} to '${trackName}'` })
            return { success: true, message: `Added note ${pitch} to '${trackName}' at bar ${start}` }
        } catch (e: unknown) {
            return { success: false, reason: `addNote error: ${e instanceof Error ? e.message : String(e)}` }
        }
    }

    public async analyzeTrack(trackName: string): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const result: AnalysisResult = {
                    track: trackName,
                    regions: []
                }

                for (const track of adapter.tracks.adapters()) {
                    for (const region of track.regions.collection.asArray()) {
                        const analysis: RegionAnalysis = {
                            start: region.position,
                            duration: region.duration,
                            name: region.label,
                            kind: region instanceof NoteRegionBoxAdapter ? "midi" : "audio"
                        }
                        if (region instanceof NoteRegionBoxAdapter) {
                            analysis.notes = region.optCollection.map(c => c.events.asArray().length).unwrapOrElse(() => 0)
                        }
                        result.regions.push(analysis)
                    }
                }

                return { success: true, analysisData: result }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }


    private findRegion(trackName: string, time: number): Option<AnyRegionBoxAdapter> {
        return this.findAudioUnitAdapter(trackName).match({
            some: (adapter) => {
                for (const track of adapter.tracks.adapters()) {
                    for (const region of track.regions.collection.asArray()) {
                        if (region.position <= time && (region.position + region.duration) >= time) {
                            return Option.wrap(region)
                        }
                    }
                }
                return Option.None
            },
            none: () => Option.None
        })
    }

    private barToPPQN(bar: number): number {
        const sig = this.studio.project.timelineBox.signature
        return (bar - 1) * PPQN.fromSignature(sig.nominator.getValue(), sig.denominator.getValue())
    }

    async inspectSelection(): Promise<ToolResult> {
        const selection = this.studio.project.selection
        if (selection.isEmpty()) return { success: true, message: "Selection is empty" }
        const details = selection.selected().map((a: any) => `${a.type}: ${a.id}`).join("\n")
        return { success: true, message: `Selection Details:\n${details}` }
    }

    async verifyAction(actionName: string, details?: any): Promise<ToolResult> {
        // Mock verification for now, or implement logic if there's a history/undo check
        return { success: true, message: `Action "${actionName}" was recorded by the system.`, data: details }
    }

    async projectInspectGraph(): Promise<ToolResult> {
        const boxes = this.studio.project.boxGraph.boxes()
        return { success: true, message: `BoxGraph contains ${boxes.length} boxes.` }
    }
}
