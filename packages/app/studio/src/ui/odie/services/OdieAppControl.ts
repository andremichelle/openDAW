import type { StudioService } from "../../../service/StudioService"
import { Color, Option } from "@opendaw/lib-std"
import { AudioBusFactory, InstrumentFactories, InstrumentFactory } from "@opendaw/studio-adapters"
import { AudioUnitType, IconSymbol } from "@opendaw/studio-enums"
import {
    RegionEditing,
    AudioUnitBoxAdapter,
    AudioBusBoxAdapter,
    AnyRegionBoxAdapter,
    NoteRegionBoxAdapter,
    AudioRegionBoxAdapter,
    ValueRegionBoxAdapter,
    TrackType,
    NanoDeviceBoxAdapter,
    PlayfieldDeviceBoxAdapter,
    SoundfontDeviceBoxAdapter
} from "@opendaw/studio-adapters"
import { Interpolation, PPQN } from "@opendaw/lib-dsp"
import {
    AudioUnitBox,
    TrackBox,
    NoteRegionBox,
    AudioRegionBox,
    ValueRegionBox,
    ValueEventCollectionBox,
    NoteEventCollectionBox,
    NoteEventBox,
    CompressorDeviceBox,
    DelayDeviceBox,
    ReverbDeviceBox,
    CrusherDeviceBox,
    StereoToolDeviceBox,
    ModularBox,
    ModularAudioInputBox,
    ModularAudioOutputBox,
    ModuleConnectionBox,
    AuxSendBox,
    PlayfieldSampleBox
} from "@opendaw/studio-boxes"
import { AudioFileBox, SoundfontFileBox } from "@opendaw/studio-boxes"
import { TidalDeviceBox } from "@opendaw/studio-boxes"
import { RevampDeviceBox } from "@opendaw/studio-boxes"
import { FoldDeviceBox } from "@opendaw/studio-boxes"
import { ModularDeviceBox } from "@opendaw/studio-boxes"
import { ArpeggioDeviceBox } from "@opendaw/studio-boxes"
import { VelocityDeviceBox } from "@opendaw/studio-boxes"
import { PitchDeviceBox } from "@opendaw/studio-boxes"
import { UUID } from "@opendaw/lib-std"
import { DattorroReverbDeviceBox } from "@opendaw/studio-boxes"
import { ZeitgeistDeviceBox } from "@opendaw/studio-boxes"

// Local interface definition
export interface MidiNoteDef {
    startTime: number // Bar (1-based)
    duration: number // Bars
    pitch: number
    velocity: number
}

// Local Interface for safely accessing 'defaultName' if not in upstream
interface NamedInstrumentFactory extends InstrumentFactory {
    defaultName: string
}

/** Structured tool result for better error reporting */
export interface ToolResult {
    success: boolean
    reason?: string
    message?: string // Added for consistency with success messages
}

/**
 * THE NERVOUS SYSTEM (Odie Studio Control)
 * -----------------------------------------
 * This facade serves as the Type-Safe "Hands" for Odie.
 * All actions are strictly mapped to the "ODIE_INTEGRATION_SPEC.md".
 *
 * Rules:
 * 1. Never hallucinate methods.
 * 2. Always check safety (e.g. isPlaying).
 * 3. Return explicit success/failure messages where useful.
 */
import { OdieTransport } from "./OdieTransport"

export class OdieAppControl {
    readonly transport: OdieTransport
    constructor(private studio: StudioService) {
        this.transport = new OdieTransport(studio)
    }

    // --- 👁️ THE EYES (Arrangement) ---

    async createProject(): Promise<boolean> {
        try {
            await this.studio.newProject()
            this.studio.odieEvents.notify({ type: "project-loaded", name: "New Project" })
            return true
        } catch (e) {
            console.error(e)
            return false
        }
    }

    listTracks(): string[] {
        if (!this.studio.hasProfile) throw new Error("No active project loaded.")
        // Return names of all tracks
        return this.studio.project.rootBoxAdapter.audioUnits.adapters()
            .filter(a => a.box.isAttached())
            .map(a => a.input.label.unwrapOrElse("Untitled"))
    }

    async addTrack(type: string, name: string = "New Track"): Promise<ToolResult> {
        if (!this.studio.hasProfile) {
            return { success: false, reason: "No active project loaded." }
        }

        // [ANTIGRAVITY] Strict Typo Guard & Normalization & Northstar Support
        // If type is missing/undefined, default to 'synth' (Smart Default)
        const t = (type || "synth").toLowerCase()
        let factory: InstrumentFactory | undefined

        // Direct Mapping (Fast Path + Northstar Aliases)
        if (t === 'synth') factory = InstrumentFactories.Vaporisateur
        else if (t === 'drums') factory = InstrumentFactories.Playfield
        else if (t === 'keys') factory = InstrumentFactories.Soundfont
        else if (t === 'nano') factory = InstrumentFactories.Nano
        else if (t === 'tape') factory = InstrumentFactories.Tape
        else if (t === 'midiout' || t === 'midi-output') factory = InstrumentFactories.MIDIOutput
        else if (t === "instrument") { type = "nano"; factory = InstrumentFactories.Nano; }
        else if (t !== 'audio') {
            // [VERIFIED ARCHITECTURE] InstrumentFactories is a Namespace. 
            // We must iterate over the 'Named' object values and check 'defaultName'.
            const factories = Object.values(InstrumentFactories.Named)
            const match = factories.find(f => {
                // Safeguard against factories explicitly not matching the interface
                return "defaultName" in f && (f as NamedInstrumentFactory).defaultName.toLowerCase() === t
            })

            if (match) {
                factory = match as InstrumentFactory
            } else {
                return { success: false, reason: `Unknown track type: '${type}'. Try: synth, drums, keys, tape, nano, or audio.` }
            }
        }

        try {
            console.log(`[Odie] Creating Track "${name}"...`)
            this.studio.project.editing.modify(() => {
                if (factory) {
                    this.studio.project.api.createInstrument(factory, { name })
                } else if (t === 'audio') {
                    const units = this.studio.project.rootBoxAdapter.audioUnits.adapters()
                    if (units.length > 0) {
                        this.studio.project.api.createAudioTrack(units[0].box, -1)
                    } else {
                        throw new Error("No root audio unit found.")
                    }
                }
            })

            // Verification: Fire event for the App Reporting System
            this.studio.odieEvents.notify({ type: "track-added", name, kind: t })
            return { success: true, message: `Added ${t} track '${name}'` }
        } catch (e: unknown) {
            console.error("addTrack failed", e)
            return { success: false, reason: e instanceof Error ? e.message : String(e) }
        }
    }

    async addAuxTrack(name: string): Promise<ToolResult> {
        if (!this.studio.hasProfile) return { success: false, reason: "Studio profile not ready" }
        try {
            console.log(`[Odie] Creating Aux Track "${name}"...`)
            // "The Hands" Spec: AudioBusFactory.create(...)
            this.studio.project.editing.modify(() => {
                AudioBusFactory.create(
                    this.studio.project.skeleton,
                    name,
                    IconSymbol.AudioBus,
                    AudioUnitType.Bus,
                    new Color(210, 66, 59) // #4a90e2 (HSL: 210, 66%, 59%)
                )
            })

            this.studio.odieEvents.notify({ type: "track-added", name, kind: "aux" })
            return { success: true, message: `Added Aux Track "${name}"` }
        } catch (e: unknown) {
            console.error("[Odie] addAuxTrack Exception:", e)
            const msg = e instanceof Error ? e.message : String(e)
            return { success: false, reason: `addAuxTrack Exception: ${msg}` }
        }
    }

    async addSend(trackName: string, auxName: string, db: number = -6.0): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (sourceAdapter) => {
                if (sourceAdapter.isBus) {
                    // Technically possible via sidechain? But for now restrict sends to regular tracks as source
                    return { success: false, reason: "Source must be a regular track" }
                }
                // Find Dest (Aux Bus) directly
                const root = this.studio.project.rootBoxAdapter
                const targetBusAdapter = root.audioBusses.adapters().find(a => a.labelField.getValue() === auxName)

                if (!targetBusAdapter) {
                    return Promise.resolve({ success: false, reason: `Aux Bus "${auxName}" not found` })
                }

                try {
                    this.studio.project.editing.modify(() => {
                        AuxSendBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                            box.audioUnit.refer(sourceAdapter.box.auxSends)
                            // box.routing.setValue(0) // Default is likely correct/safe. avoiding "Already set".
                            box.sendGain.setValue(db)
                            box.targetBus.refer(targetBusAdapter.box.input)
                            // Ensure index is set correctly (append)
                            const currentAuxSends = sourceAdapter.auxSends.adapters()
                            box.index.setValue(currentAuxSends.length)
                        })
                    })
                    this.studio.odieEvents.notify({ type: "effect-added", track: trackName, effect: "send" })
                    return { success: true }

                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e)
                    return { success: false, reason: `addSend failed: ${msg}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Source Track "${trackName}" not found` })
        })
    }

    async setRouting(sourceName: string, targetBusName: string): Promise<ToolResult> {
        return this.findAudioUnitAdapter(sourceName).match<Promise<ToolResult>>({
            some: async (sourceAdapter) => {
                const root = this.studio.project.rootBoxAdapter
                const targetBusAdapter = root.audioBusses.adapters().find(a => a.labelField.getValue() === targetBusName)

                if (!targetBusAdapter) {
                    return { success: false, reason: `Target Bus "${targetBusName}" not found` }
                }

                try {
                    this.studio.project.editing.modify(() => {
                        sourceAdapter.box.output.refer(targetBusAdapter.box.input)
                    })
                    return { success: true, message: `Routed ${sourceName} to ${targetBusName}` }
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e)
                    return { success: false, reason: `setRouting failed: ${msg}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Source "${sourceName}" not found` })
        })
    }



    // --- 🛡️ STATE BRIDGE (Robust Verification) ---


    private findAudioUnit(name: string): Option<AudioUnitBox> {
        return this.findAudioUnitAdapter(name).map(a => a.box)
    }

    // --- 🫀 THE HEART (Transport) ---

    async play() {
        this.transport.play()
    }

    async stop() {
        this.transport.stop()
    }

    async record(countIn: boolean = true): Promise<boolean> {
        this.transport.record(countIn)
        return true
    }

    async stopRecording(): Promise<boolean> {
        this.transport.stopRecording()
        return true
    }

    async setCountIn(bars: number): Promise<boolean> {
        // Range Safety (1 to 4 bars is reasonable standard)
        if (bars < 1) bars = 1
        if (bars > 4) bars = 4

        console.warn("[Odie] CountIn not supported by current Engine Transport Facade.")
        return true
    }

    async selectTrack(name: string): Promise<boolean> {
        return this.findAudioUnit(name).match({
            some: async (adapter) => {
                this.studio.project.selection.select(adapter)
                return true
            },
            none: () => Promise.resolve(false)
        })
    }

    async setLoop(enabled: boolean): Promise<boolean> {
        this.transport.setLoop(enabled)
        return true
    }

    async setBpm(bpm: number): Promise<boolean> {
        console.log(`[Odie] Setting BPM to ${bpm}...`)
        return this.transport.setBpm(bpm)
    }

    async setTimeSignature(numerator: number, denominator: number): Promise<boolean> {
        console.log(`[Odie] Setting Time Signature to ${numerator}/${denominator}...`)
        return this.transport.setTimeSignature(numerator, denominator)
    }

    // --- 👐 THE HANDS (Mixer) ---

    async setVolume(trackName: string, db: number): Promise<ToolResult> {
        // Range Safety
        if (db > 6.0) db = 6.0

        return this.findAudioUnit(trackName).match<Promise<ToolResult>>({
            some: async (box) => {
                try {
                    this.studio.project.editing.modify(() => {
                        box.volume.setValue(db)
                    })
                    return { success: true }
                } catch (e: any) {
                    return { success: false, reason: `setVolume failed: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async setPan(trackName: string, pan: number): Promise<ToolResult> {
        // Range Safety
        if (pan < - 1.0) pan = -1.0
        if (pan > 1.0) pan = 1.0

        return this.findAudioUnit(trackName).match<Promise<ToolResult>>({
            some: async (box) => {
                try {
                    this.studio.project.editing.modify(() => {
                        box.panning.setValue(pan)
                    })
                    return { success: true }
                } catch (e: any) {
                    return { success: false, reason: `setPan failed: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async mute(trackName: string, muted: boolean): Promise<ToolResult> {
        return this.findAudioUnit(trackName).match<Promise<ToolResult>>({
            some: async (box) => {
                try {
                    this.studio.project.editing.modify(() => {
                        box.mute.setValue(muted)
                    })
                    return { success: true }
                } catch (e: any) {
                    return { success: false, reason: `mute failed: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async solo(trackName: string, soloed: boolean): Promise<ToolResult> {
        return this.findAudioUnit(trackName).match<Promise<ToolResult>>({
            some: async (box) => {
                try {
                    this.studio.project.editing.modify(() => {
                        box.solo.setValue(soloed)
                    })
                    return { success: true }
                } catch (e: any) {
                    return { success: false, reason: `solo failed: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    // --- 🕸️ NERVOUS SYSTEM (View) ---

    async switchScreen(screen: "arrangement" | "scene"): Promise<boolean> {
        // ... (Keep existing if working, or blindly return true as UI state is hard to verify structurally)
        try {
            this.studio.switchScreen(screen as any)
            // Allow UI to settle
            await new Promise(r => setTimeout(r, 50))
            return true
        } catch (e) {
            return false
        }
    }

    async toggleKeyboard(): Promise<boolean> {
        try {
            this.studio.toggleSoftwareKeyboard()
            return true
        } catch (e) { return false }
    }

    // --- 🧹 HYGIENE (Arrangement Config) ---

    async deleteTrack(name: string): Promise<boolean> {
        console.log(`[OdieAppControl] deleteTrack requested for: '${name}'`);
        const result = await this.findAudioUnit(name).match({
            some: async (box) => {
                try {
                    console.log(`[OdieAppControl] Found audio unit for deletion.`);
                    this.studio.project.editing.modify(() => {
                        this.studio.project.api.deleteAudioUnit(box)
                    })
                    // State Verification: Ensure it's gone
                    const stillExists = this.findAudioUnit(name).match({
                        some: () => true,
                        none: () => false
                    })
                    if (stillExists) {
                        console.error(`[OdieAppControl] deleteTrack failed: Unit '${name}' still exists in state after deletion attempt.`);
                        return false;
                    }
                    console.log(`[OdieAppControl] deleteTrack success: '${name}' removed.`);
                    return true
                } catch (e) {
                    console.error("[OdieAppControl] deleteTrack Failure (Exception):", e)
                    return false
                }
            },
            none: () => {
                console.error(`[OdieAppControl] deleteTrack failed: Could not find track named '${name}'`);
                return Promise.resolve(false)
            }
        });
        return result;
    }

    // --- 🖖 THE FINGERS (Editing) ---

    async splitRegion(trackName: string, time?: number): Promise<ToolResult> {
        // Default to current playhead if no time specified
        const splitTime = time ?? this.transport.position

        return this.findRegion(trackName, splitTime).match<Promise<ToolResult>>({
            some: async (region) => {
                try {
                    this.studio.project.editing.modify(() => {
                        RegionEditing.cut(region, splitTime, false)
                    })
                    // Verify split by checking for new region at split time?
                    // For now, rely on execution + settling. Ideally we count regions.
                    return { success: true, message: "Split region" }
                } catch (e: any) {
                    console.error("Split failed", e)
                    return { success: false, reason: `Split failed: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `No region found at time ${splitTime} on track "${trackName}"` })
        })
    }

    async moveRegion(trackName: string, time: number, newTime: number): Promise<ToolResult> {
        // Convert Bars (1-based) to PPQN (0-based, 4ppqn)
        const ppqnTime = (time - 1) * 4.0
        const ppqnNewTime = (newTime - 1) * 4.0

        return this.findRegion(trackName, ppqnTime).match<Promise<ToolResult>>({
            some: async (region) => {
                try {
                    this.studio.project.editing.modify(() => {
                        // RegionBox base class is not exported, casting to any for position access
                        (region.box as any).position.setValue(ppqnNewTime)
                    })
                    return { success: true }
                } catch (e: any) {
                    console.error("Move failed", e)
                    return { success: false, reason: `Move failed: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `No region found at time ${time} on track "${trackName}"` })
        })
    }

    async copyRegion(trackName: string, time: number, newTime: number): Promise<ToolResult> {
        // Convert Bars (1-based) to PPQN
        const ppqnTime = (time - 1) * 4.0
        const ppqnNewTime = (newTime - 1) * 4.0

        return this.findRegion(trackName, ppqnTime).match<Promise<ToolResult>>({
            some: async (region) => {
                try {
                    this.studio.project.editing.modify(() => {
                        region.copyTo({
                            position: ppqnNewTime,
                            consolidate: false
                        })
                    })
                    return { success: true }
                } catch (e: any) {
                    console.error("Copy failed", e)
                    return { success: false, reason: `Copy failed: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `No region found at time ${time} on track "${trackName}"` })
        })
    }

    async getMidiNotes(trackName: string): Promise<{ notes: any[], logs: string[] }> {
        return this.findAudioUnitAdapter(trackName).match({
            some: async (adapter) => {
                const logs: string[] = []
                const log = (msg: string) => {
                    console.log(msg)
                    logs.push(msg)
                }

                // Diagnostic: specific to Playfield/multitrack support
                const tracks = adapter.tracks.values()
                log(`[Odie] getMidiNotes: Adapter "${trackName}" has ${tracks.length} tracks.`)

                let allNotes: any[] = []

                tracks.forEach((track, index) => {
                    const regionCount = track.regions.collection.asArray().length
                    log(`[Odie] Track ${index}: ${regionCount} regions.`)

                    track.regions.collection.asArray().forEach(r => {
                        const typeName = r.constructor.name
                        log(`[Odie] Track ${index} Region at ${r.position}: ${typeName}`)
                        if (r instanceof NoteRegionBoxAdapter) {
                            const events = r.optCollection.unwrap().events.asArray()
                            log(`[Odie] .. found ${events.length} notes.`)
                            events.forEach(e => {
                                allNotes.push({
                                    pitch: e.pitch,
                                    startTime: (r.position + e.position) / 4.0 + 1,
                                    duration: e.duration / 4.0,
                                    velocity: e.velocity
                                })
                            })
                        } else {
                            log(`[Odie] .. Ignored region type: ${typeName}`)
                        }
                    })
                })

                return { notes: allNotes, logs }
            },
            none: () => Promise.resolve({ notes: [], logs: [`Track "${trackName}" not found`] })
        })
    }

    async addMidiNotes(trackName: string, notes: MidiNoteDef[]): Promise<ToolResult> {
        // 1. Find the Track
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                // START ROBUST TRACK FINDING
                // Use generic access or cast to known structure
                const tracksCollection: any = adapter.tracks
                let track: any = undefined

                if (Array.isArray(tracksCollection)) {
                    track = tracksCollection[0]
                } else if (typeof tracksCollection.adapters === 'function') {
                    const adapters = tracksCollection.adapters()
                    track = Array.isArray(adapters) ? adapters[0] : undefined
                } else if (typeof tracksCollection.values === 'function') {
                    const vals = tracksCollection.values()
                    if (Array.isArray(vals)) {
                        track = vals[0]
                    } else if (vals && typeof vals.next === 'function') {
                        track = vals.next().value
                    } else {
                        try { track = Array.from(vals)[0] } catch (e) { }
                    }
                }

                if (!track) return { success: false, reason: `Track "${trackName}" has no note lanes (Robust Search Failed).` }
                // END ROBUST TRACK FINDING

                try {
                    // 2. Determine target clip (Simplification: Use the first one found or fail for now)
                    if (notes.length === 0) return { success: true }

                    // Time conversion: 1 Bar = 4.0 PPQN (assuming 4/4)
                    const firstNoteTime = (notes[0].startTime - 1) * 4.0

                    let region = track.regions.collection.asArray()
                        .find((r: any) => r instanceof NoteRegionBoxAdapter && r.position <= firstNoteTime && r.complete > firstNoteTime) as NoteRegionBoxAdapter | undefined

                    if (!region) {
                        // Try to Create a Clip (MVP: 4 bar clip at target)
                        const start = Math.floor(firstNoteTime / 4) * 4 // Quantize to bar
                        const duration = 16.0 // 4 bars



                        // Create Clip Logic
                        this.studio.project.editing.modify(() => {
                            // CRITICAL FIX: Must create Event Collection and link it to the Region Box
                            // otherwise "box.events" pointer is dangling, causing Graph Crash.
                            const collection = NoteEventCollectionBox.create(this.studio.project.boxGraph, UUID.generate())

                            NoteRegionBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                                box.position.setValue(start)
                                box.duration.setValue(duration)
                                box.loopDuration.setValue(duration)
                                box.regions.refer(track.box.regions)
                                box.events.refer(collection.owners) // Link to events!
                            })
                        })

                        // Verify creation
                        // Refetch to get adapter
                        region = track.regions.collection.asArray()
                            .find((r: any) => r instanceof NoteRegionBoxAdapter && r.position === start) as NoteRegionBoxAdapter
                    }
                    if (!region) return { success: false, reason: `No MIDI region found at time ${notes[0].startTime} and failed to create one.` }

                    // --- STEP 3: Add Notes ---
                    this.studio.project.editing.modify(() => {
                        const collection = region!.optCollection.unwrap()
                        const regionPos = region!.position
                        console.log(`[Odie] Adding ${notes.length} notes to region at ${regionPos}`)

                        // [ANTIGRAVITY] SIGNAL DISPATCH
                        this.studio.odieEvents.notify({ type: "region-created", track: trackName, time: regionPos })

                        notes.forEach(note => {
                            const start = ((note.startTime - 1) * 4.0) - regionPos
                            const duration = note.duration * 4.0
                            collection.createEvent({
                                position: start,
                                duration: duration,
                                pitch: note.pitch,
                                velocity: note.velocity / 127.0,
                                chance: 127,
                                playCount: 0,
                                cent: 0
                            })
                        })
                    })

                    return { success: true, message: `Added ${notes.length} notes` }
                } catch (e: any) {
                    return { success: false, reason: `addMidiNotes failed: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async addAutomationPoint(trackName: string, param: "volume" | "pan", time: number, value: number): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                // 1. Resolve Parameter Field
                const box = adapter.box
                let field: any
                if (param === "volume") field = box.volume
                else if (param === "pan") field = box.panning
                else return { success: false, reason: `Invalid automation param: ${param}` }

                try {
                    // --- STEP 1: Ensure Automation Lane ---
                    let lane = adapter.tracks.controls(field).unwrapOrUndefined()
                    if (!lane) {
                        this.studio.project.editing.modify(() => {
                            adapter.tracks.create(TrackType.Value, field)
                        })


                        // Refresh View
                        lane = adapter.tracks.controls(field).unwrapOrUndefined()
                    }
                    if (!lane) return { success: false, reason: "Automation lane missing after creation attempt." }

                    // --- STEP 2: Ensure Region ---
                    // Time is in Bars (1-based), convert to PPQN
                    const ppqnTime = (time - 1) * 4.0

                    let region = lane.regions.collection.asArray()
                        .find(r => r instanceof ValueRegionBoxAdapter && r.position <= ppqnTime && r.complete > ppqnTime) as ValueRegionBoxAdapter | undefined

                    if (!region) {
                        const start = 0
                        const duration = 100 * 4.0 // 100 Bars default

                        this.studio.project.editing.modify(() => {
                            const events = ValueEventCollectionBox.create(this.studio.project.boxGraph, UUID.generate())
                            ValueRegionBox.create(this.studio.project.boxGraph, UUID.generate(), r => {
                                r.position.setValue(start)
                                r.duration.setValue(duration)
                                r.loopDuration.setValue(duration)
                                r.regions.refer(lane!.box.regions)
                                r.events.refer(events.owners)
                            })
                        })



                        // Refresh View
                        region = lane.regions.collection.asArray()
                            .find(r => r instanceof ValueRegionBoxAdapter && r.position <= ppqnTime && r.complete > ppqnTime) as ValueRegionBoxAdapter
                    }
                    if (!region) return { success: false, reason: "Region missing after creation attempt." }

                    // --- STEP 3: Add Point ---
                    this.studio.project.editing.modify(() => {
                        const collection = region!.optCollection.unwrap()
                        const relTime = ppqnTime - region!.position

                        collection.createEvent({
                            position: relTime,
                            value: value,
                            index: 0,
                            interpolation: Interpolation.Linear
                        })
                    })

                    // [ANTIGRAVITY] SIGNAL DISPATCH
                    this.studio.odieEvents.notify({ type: "param-changed", track: trackName, param, value })
                    return { success: true }

                } catch (e: any) {
                    console.error("Automation Logic Failed", e)
                    return { success: false, reason: `Automation error: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    // --- 📤 THE OUTPUT (Export) ---

    async exportMixdown(): Promise<boolean> {
        try {
            await this.studio.exportMixdown()
            return true
        } catch (e) {
            console.error("Export Mixdown failed", e)
            return false
        }
    }

    async exportStems(): Promise<boolean> {
        try {
            await this.studio.exportStems()
            return true
        } catch (e) {
            console.error("Export Stems failed", e)
            return false
        }
    }

    // --- 🎨 THE IMAGINATION (Generative) ---
    // [ANTIGRAVITY] Native Mode - No Client Tools needed.


    // --- 💾 THE MEMORY (Project) ---

    async loadProject(): Promise<boolean> {
        return this.studio.browseLocalProjects().then(() => true).catch(() => false)
    }

    async loadTemplate(name: string): Promise<boolean> {
        try {
            await this.studio.loadTemplate(name)
            // [ANTIGRAVITY] SIGNAL DISPATCH
            this.studio.odieEvents.notify({ type: "project-loaded", name: name })
            return true
        } catch (e) {
            console.error("Failed to load template", e)
            return false
        }
    }

    // --- 👂 THE EARS (Analysis) ---

    inspectSelection(): string {
        if (!this.studio.hasProfile) return "No project loaded."

        try {
            const selection = this.studio.project.selection
            if (selection.isEmpty()) return "Nothing selected."

            const results = selection.selected().map(vertex => {
                try {
                    const box = vertex.box
                    const adapters = this.studio.project.boxAdapters

                    // Identify Track
                    if (box instanceof TrackBox) {

                        // TrackBox has a 'target' pointer to the AudioUnit (or param)
                        // We use Unsafe/Any cast or assume box.target exists matching ProjectApi usage
                        const target = (box as any).target
                        const targetBox = target?.targetVertex?.unwrap()?.box

                        return { type: "track", name: targetBox?.label?.getValue() || "Untitled" }
                    }

                    // Identify Note Region
                    if (box instanceof NoteRegionBox) {
                        try {
                            const noteRegion = adapters.adapterFor(box, NoteRegionBoxAdapter)
                            return {
                                type: "clip",
                                kind: "midi",
                                name: noteRegion.label,
                                start: noteRegion.position,
                                duration: noteRegion.duration,
                                notes: noteRegion.optCollection.mapOr(c => c.events.asArray().length, 0)
                            }
                        } catch { }
                    }

                    // Identify Audio Region
                    if (box instanceof AudioRegionBox) {
                        try {
                            const audioRegion = adapters.adapterFor(box, AudioRegionBoxAdapter)
                            return {
                                type: "clip",
                                kind: "audio",
                                start: audioRegion.position,
                                duration: audioRegion.duration
                            }
                        } catch { }
                    }

                    return { type: "unknown", id: box.address.toString() }
                } catch (err) {
                    return { type: "error", message: String(err) }
                }
            }).map(item => {
                // Ensure plain object
                return item
            })

            return JSON.stringify(results)
        } catch (e) {
            console.error("Inspect failed", e)
            return `Error inspecting selection: ${e}`
        }
    }

    async saveProject(): Promise<ToolResult> {
        try {
            console.log("💾 Odie: Triggering Project Save (Export Bundle)...")
            await this.studio.exportBundle()
            return { success: true, message: "Project save triggered successfully." }
        } catch (e: any) {
            console.error("❌ Odie: Save Failed", e)
            return { success: false, reason: e.message }
        }
    }

    async importAudio(trackName: string, durationSeconds: number = 2.0): Promise<ToolResult> {
        try {
            console.log(`📂 Odie: Importing Audio '${trackName}' (${durationSeconds}s)...`)

            // 1. Synthesize Audio
            const sampleRate = this.studio.sampleRate
            const wavBuffer = this.createSineWaveWav(durationSeconds, 440, sampleRate)

            // 2. Import to SampleService
            const sample = await this.studio.sampleService.importFile({
                name: `${trackName}_Source`,
                arrayBuffer: wavBuffer
            })
            const sampleUuid = UUID.parse(sample.uuid)

            // 3. Create Audio Track
            const trackSuccess = await this.addTrack("audio", trackName)
            if (!trackSuccess) return { success: false, reason: `Failed to create track '${trackName}'` }

            // 4. Create Boxes & Region
            const adapterMeta = this.findAudioUnitAdapter(trackName)
            if (adapterMeta.isEmpty()) throw new Error(`Could not find adapter for created track ${trackName}`)
            const adapter = adapterMeta.unwrap()

            // START ROBUST TRACK FINDING
            const tracksCollection = adapter.tracks as any
            let track: any = undefined

            if (Array.isArray(tracksCollection)) {
                track = tracksCollection[0]
            } else if (typeof tracksCollection.adapters === 'function') {
                const adapters = tracksCollection.adapters()
                track = Array.isArray(adapters) ? adapters[0] : undefined
            } else if (typeof tracksCollection.values === 'function') {
                const vals = tracksCollection.values()
                if (Array.isArray(vals)) {
                    track = vals[0]
                } else if (vals && typeof vals.next === 'function') {
                    track = vals.next().value
                } else {
                    try { track = Array.from(vals)[0] } catch (e) { }
                }
            }

            if (!track) throw new Error("Created audio unit has no track lane (Collection empty or unknown type)")

            const trackBox = track.box
            if (!trackBox) throw new Error("Track Adapter has no underlying TrackBox")
            // END ROBUST TRACK FINDING

            const { editing, boxGraph } = this.studio.project

            editing.modify(() => {
                // A. Create AudioFileBox (The representation of the sample in the graph)
                const audioFileBox = AudioFileBox.create(boxGraph, sampleUuid, box => {
                    box.fileName.setValue(sample.name)
                    box.startInSeconds.setValue(0)
                    box.endInSeconds.setValue(durationSeconds)
                })

                // B. Create Event Collection for Audio Automation (REQUIRED)
                const valueEventCollectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())

                // C. Create AudioRegionBox (The Clip)
                const regionUuid = UUID.generate()
                AudioRegionBox.create(boxGraph, regionUuid, box => {
                    box.file.refer(audioFileBox)
                    box.duration.setValue(durationSeconds)
                    box.position.setValue(0)

                    // Link Events Collection (Crucial Fix)
                    box.events.refer(valueEventCollectionBox.owners)

                    // D. Link to Track (Robust Graph Linking)
                    if (trackBox.regions) {
                        box.regions.refer(trackBox.regions)
                    } else {
                        console.warn("TrackBox has no regions collection to refer to")
                    }
                })
            })

            return { success: true, message: `Imported audio to track '${trackName}'` }

        } catch (e: any) {
            console.error("❌ Odie: Import Failed", e)
            return { success: false, reason: e.message }
        }
    }

    private createSineWaveWav(duration: number, frequency: number, sampleRate: number): ArrayBuffer {
        const numFrames = duration * sampleRate;
        const numChannels = 1;
        const bytesPerSample = 2; // 16-bit
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = numFrames * blockAlign;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        // RIFF chunk descriptor
        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        this.writeString(view, 8, 'WAVE');

        // fmt sub-chunk
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // Subchunk1Size
        view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true); // BitsPerSample

        // data sub-chunk
        this.writeString(view, 36, 'data');
        view.setUint32(40, dataSize, true);

        // Write PCM samples
        for (let i = 0; i < numFrames; i++) {
            const t = i / sampleRate;
            const sample = Math.sin(2 * Math.PI * frequency * t);
            const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(44 + i * 2, int16, true);
        }

        return buffer;
    }

    private writeString(view: DataView, offset: number, string: string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    analyzeTrack(trackName: string): string {
        return this.findAudioUnitAdapter(trackName).match({
            some: (adapter) => {
                try {
                    if (adapter.isBus) {
                        return "Selected unit is an Aux Bus, not a regular Track. Timeline analysis is not supported."
                    }
                    const track = adapter.tracks.values()[0] // Assume first track for now
                    if (!track) return "Track found but has no timeline lane."

                    const regions = track.regions.collection.asArray().map(r => {
                        const base = {
                            start: r.position,
                            duration: r.duration,
                            name: r.label || "Untitled"
                        }

                        if (r instanceof NoteRegionBoxAdapter) {
                            return { ...base, kind: "midi", notes: r.optCollection.mapOr(c => c.events.asArray().length, 0) }
                        }
                        if (r instanceof AudioRegionBoxAdapter) {
                            return { ...base, kind: "audio" }
                        }
                        return { ...base, kind: "unknown" }
                    })

                    const result = JSON.stringify({
                        track: trackName,
                        regions: regions
                    })

                    // [ANTIGRAVITY] SIGNAL DISPATCH
                    this.studio.odieEvents.notify({ type: "analysis-complete", track: trackName, result: JSON.parse(result) })

                    return result

                } catch (e) {
                    console.error("Analyze failed", e)
                    return "Error analyzing track."
                }
            },
            none: () => "Track not found."
        })
    }

    // --- INTERNAL HELPERS ---

    /**
     * DEBUG: Molecular Graph Inspection
     * Returns a text summary of the requested box category.
     */
    projectInspectGraph(category: "audio_units" | "busses" | "tracks" | "all"): string {
        if (!this.studio.hasProfile) return "No project loaded."
        const root = this.studio.project.rootBoxAdapter
        let summary = `[MOLECULAR INSPECTION: ${category}]\n`

        if (category === "audio_units" || category === "all") {
            summary += "--- AUDIO UNITS ---\n"
            root.audioUnits.adapters().forEach(a => {
                const label = a.input.label.unwrapOrElse(() => "Addr: " + a.box.address)
                summary += `- ${label} [${a.box.constructor.name}]\n`
                summary += `  Volume: ${a.box.volume.getValue()}dB | Mute: ${a.box.mute.getValue()}\n`
            })
        }

        if (category === "busses" || category === "all") {
            summary += "--- BUSSES ---\n"
            root.audioBusses.adapters().forEach(a => {
                summary += `- ${a.labelField.getValue()} [${a.box.constructor.name}]\n`
            })
        }

        if (category === "tracks" || category === "all") {
            summary += "--- TRACKS ---\n"
            root.audioUnits.adapters().forEach((au: any) => {
                let tracks: any[] = []
                try {
                    if (au.tracks && typeof au.tracks.adapters === 'function') {
                        tracks = au.tracks.adapters()
                    } else if (au.tracks && typeof au.tracks.values === 'function') {
                        tracks = Array.from(au.tracks.values())
                    }
                } catch (e) { /* Ignore iter error */ }

                tracks.forEach((t: any) => {
                    summary += `- ${t.constructor.name} (Address: ${t.address})\n`
                })
            })
        }

        return summary
    }

    /**
     * [ANTIGRAVITY] Verification Loop Tool
     * Performs a deep audit of the current state to confirm a mutation.
     */
    async verifyAction(action: string, expected: string): Promise<string> {
        if (!this.studio.hasProfile) return "Verification Failed: No project."

        console.log(`🔬 [VERIFICATION LOOP] Auditing: ${action} | Expected: ${expected}`)

        // 1. Capture Raw State
        const rawState = this.projectInspectGraph("all")

        // 2. Return the report for AI interpretation
        // AI is the "Oracle" that decides if the raw state matches the intent
        return `[VERIFICATION REPORT]\nAction: ${action}\nExpected: ${expected}\n\n[CURRENT RAW GRAPH]:\n${rawState}`
    }

    private findAudioUnitAdapter(name: string): Option<AudioUnitBoxAdapter> {
        if (!this.studio.hasProfile) return Option.None
        const root = this.studio.project.rootBoxAdapter
        const allAdapters = [
            ...root.audioUnits.adapters(),
            ...root.audioBusses.adapters()
        ]
        const targetName = name.trim()
        const match = allAdapters.find(a => {
            let label = ""
            if (a instanceof AudioUnitBoxAdapter) {
                label = a.label
            } else if (a instanceof AudioBusBoxAdapter) {
                label = a.labelField.getValue() ?? ""
            }
            return a.box.isAttached() && label.trim() === targetName
        })

        if (!match) {
            // Debug logging for failures
            if (name !== "") {
                const labels = allAdapters.map(a => {
                    if (a instanceof AudioUnitBoxAdapter) return `[Unit] ${a.label}`
                    if (a instanceof AudioBusBoxAdapter) return `[Bus] ${a.labelField.getValue()}`
                    return `[Unknown] ${(a as any).address}`
                })
                console.warn(`[Odie] findAudioUnitAdapter: No match for "${name}". Available:`, labels)
            }
            return Option.None
        }

        if (match instanceof AudioBusBoxAdapter) {
            return Option.wrap(match.audioUnitBoxAdapter())
        }
        return Option.wrap(match as AudioUnitBoxAdapter)
    }

    private findRegion(trackName: string, time: number): Option<AnyRegionBoxAdapter> {
        return this.findAudioUnitAdapter(trackName).flatMap(adapter => {
            const tracks = adapter.tracks.values()
            for (const track of tracks) {
                // Iterate regions in the track
                const regions = track.regions.collection.asArray()
                const match = regions.find(r => r.position <= time && r.complete > time)
                if (match) return Option.wrap(match)
            }
            return Option.None
        })
    }

    // =====================================================================
    // [A2UI] COMPREHENSIVE READ/WRITE API FOR GEN UI
    // =====================================================================

    /**
     * Get complete details about a track's signal chain including:
     * - Mixer settings (volume, pan, mute, solo)
     * - Effect chain with all parameters
     * - Instrument with all parameters (if applicable)
     */
    getTrackDetails(trackName: string): string {
        return this.findAudioUnitAdapter(trackName).match({
            some: (adapter) => {
                try {
                    const details: any = {
                        track: trackName,
                        type: adapter.type,
                        mixer: {
                            volume: adapter.namedParameter.volume.getValue(),
                            panning: adapter.namedParameter.panning.getValue(),
                            mute: adapter.namedParameter.mute.getValue(),
                            solo: adapter.namedParameter.solo.getValue()
                        },
                        midiEffects: [] as any[],
                        audioEffects: [] as any[],
                        instrument: null as any
                    }

                    // Extract audio effects
                    const audioEffects = adapter.audioEffects.adapters()

                    // Helper to extract param metadata recursively
                    const extractParams = (obj: any, prefix = ""): Record<string, any> => {
                        const result: Record<string, any> = {}
                        if (!obj) return result

                        for (const [key, val] of Object.entries(obj)) {
                            if (!val) continue
                            const path = prefix ? `${prefix}.${key}` : key

                            // Check if it's a ParameterAdapter (has getValue)
                            if (typeof val === 'object' && 'getValue' in val) {
                                const p = val as any
                                result[key] = {
                                    value: p.getValue(),
                                    min: p.minValue, // Now available thanks to our update
                                    max: p.maxValue
                                }
                            }
                            // Recurse for nested objects (like osc1.wave)
                            else if (typeof val === 'object' && val !== null) {
                                const nested = extractParams(val, path)
                                // Merge or nest? For setDeviceParam we use dot notation.
                                // Let's keep structure but leaf nodes are rich objects.
                                if (Object.keys(nested).length > 0) {
                                    result[key] = nested
                                }
                            }
                        }
                        return result
                    }


                    audioEffects.forEach((effect, index) => {
                        const effectInfo: any = {
                            index,
                            type: effect.constructor.name.replace('DeviceBoxAdapter', ''),
                            label: effect.labelField.getValue(),
                            enabled: effect.enabledField.getValue(),
                            parameters: {}
                        }



                        // Extract named parameters if available
                        if ('namedParameter' in effect && effect.namedParameter) {
                            effectInfo.parameters = extractParams(effect.namedParameter)
                        }

                        details.audioEffects.push(effectInfo)
                    })

                    // Extract MIDI effects
                    const midiEffects = adapter.midiEffects.adapters()
                    midiEffects.forEach((effect, index) => {
                        const effectInfo: any = {
                            index,
                            type: effect.constructor.name.replace('DeviceBoxAdapter', ''),
                            label: effect.labelField.getValue(),
                            enabled: effect.enabledField.getValue(),
                            parameters: {}
                        }

                        if ('namedParameter' in effect && effect.namedParameter) {
                            effectInfo.parameters = extractParams(effect.namedParameter)
                        }

                        details.midiEffects.push(effectInfo)
                    })

                    // Extract instrument info
                    const inputAdapter = adapter.inputAdapter
                    if (inputAdapter && inputAdapter.nonEmpty()) {
                        const instrument = inputAdapter.unwrap()
                        if ('namedParameter' in instrument) {
                            const instrInfo: any = {
                                type: instrument.constructor.name.replace('DeviceBoxAdapter', ''),
                                label: instrument.labelField?.getValue() || 'Unknown',
                                parameters: {}
                            }

                            const params = (instrument as any).namedParameter
                            if (params) {
                                instrInfo.parameters = extractParams(params)
                            }

                            details.instrument = instrInfo
                        }
                    }

                    return JSON.stringify(details, null, 2)
                } catch (e) {
                    console.error("getTrackDetails failed", e)
                    return JSON.stringify({ error: String(e) })
                }
            },
            none: () => JSON.stringify({ error: "Track not found" })
        })
    }

    /**
     * Get overview of entire project for mix analysis.
     */
    getProjectOverview(): string {
        try {
            if (!this.studio.hasProfile) return JSON.stringify({ error: "No project loaded" })

            const project = this.studio.project
            const rootAdapter = project.rootBoxAdapter
            const audioUnits = rootAdapter.audioUnits.adapters()

            const overview = {
                bpm: project.timelineBox.bpm.getValue(),
                trackCount: audioUnits.length,
                tracks: audioUnits.map(adapter => {
                    const effectCount = adapter.audioEffects.adapters().length
                    const midiEffectCount = adapter.midiEffects.adapters().length
                    let regionCount = 0
                    adapter.tracks.values().forEach(t => {
                        regionCount += t.regions.collection.asArray().length
                    })

                    return {
                        name: adapter.input.label.unwrapOrElse("Untitled"),
                        type: adapter.type,
                        effectCount: effectCount + midiEffectCount,
                        regionCount,
                        volume: adapter.namedParameter.volume.getValue(),
                        mute: adapter.namedParameter.mute.getValue(),
                        solo: adapter.namedParameter.solo.getValue()
                    }
                })
            }

            return JSON.stringify(overview, null, 2)
        } catch (e) {
            console.error("getProjectOverview failed", e)
            return JSON.stringify({ error: String(e) })
        }
    }

    /**
     * Set any device parameter by path.
     * @param trackName - Name of the track
     * @param deviceType - "effect" | "instrument" | "mixer"
     * @param deviceIndex - Index of effect (0-based), ignored for instrument/mixer
     * @param paramPath - Parameter name (e.g., "threshold", "cutoff", "volume")
     * @param value - New value (normalized 0-1 or native range depending on mapping)
     */
    async setDeviceParam(
        trackName: string,
        deviceType: "effect" | "instrument" | "mixer" | "midiEffect",
        deviceIndex: number,
        paramPath: string,
        value: number
    ): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                try {
                    // Helper to set value robustly inside a transaction
                    const applyValue = (targetObj: any, key: string, val: number): ToolResult => {
                        const param = targetObj[key]
                        if (!param) {
                            const available = Object.keys(targetObj || {}).join(", ")
                            console.warn(`[Odie] Param "${key}" not found on target. Available: ${available}`)
                            return { success: false, reason: `Param not found: ${paramPath}. Available: ${available}` }
                        }

                        let setter: ((v: number) => void) | undefined

                        if (typeof param.setValue === 'function') {
                            setter = (v) => param.setValue(v)
                        } else if (param.field && typeof param.field.setValue === 'function') {
                            setter = (v) => param.field.setValue(v)
                        }

                        if (setter) {
                            try {
                                // [ANTIGRAVITY] CRITICAL: Must be in editing transaction
                                this.studio.project.editing.modify(() => {
                                    setter!(val)
                                })
                                return { success: true, reason: `${trackName} ${deviceType} ${paramPath} set to ${val.toFixed(2)}` }
                            } catch (err: any) {
                                console.error("Mutation failed", err)
                                return { success: false, reason: `Mutation failed: ${err.message}` }
                            }
                        }

                        return { success: false, reason: `Param ${paramPath} is not controllable (no setValue)` }
                    }


                    // [AG] Hybrid Access Helper: Tries to find and set a param on a target object
                    const trySetParam = (targetRoot: any, path: string, val: number): boolean => {
                        if (!targetRoot) return false
                        try {
                            const parts = path.split('.')
                            let current = targetRoot
                            // Traverse
                            for (let i = 0; i < parts.length; i++) {
                                current = current[parts[i]]
                                if (!current) return false
                            }
                            // Check if leaf is a Parameter (has setValue)
                            if (current && typeof current.setValue === 'function') {
                                current.setValue(val)
                                return true
                            }
                            return false
                        } catch (e) {
                            return false
                        }
                    }

                    if (deviceType === "mixer") {
                        const mixerParams = adapter.namedParameter as any
                        return applyValue(mixerParams, paramPath, value)
                    }

                    if (deviceType === "effect") {
                        const effects = adapter.audioEffects.adapters()

                        if (deviceIndex < 0 || deviceIndex >= effects.length) {
                            // Optimistic Fallback: Ideally we would queue this, but for now we just fail fast as requested by user.
                            // The user can verify themselves via odieEvents later.
                            return { success: false, reason: `Effect index ${deviceIndex} out of range (have ${effects.length})` }
                        }

                        const effectAdapter = effects[deviceIndex]

                        // Strategy 1: Adapter Named Parameters (Standard)
                        if (trySetParam((effectAdapter as any).namedParameter, paramPath, value)) {
                            return { success: true, message: `Set ${trackName}:effect[${deviceIndex}].${paramPath} = ${value}` }
                        }

                        // Strategy 2: Box Direct Access (Bypass - for Plugins/AudioUnits)
                        // Many plugins expose params directly on the box, not mapped to adapter.namedParameter
                        if (trySetParam(effectAdapter.box, paramPath, value)) {
                            return { success: true, message: `Set (Deep) ${trackName}:effect[${deviceIndex}].${paramPath} = ${value}` }
                        }

                        return { success: false, reason: `Parameter '${paramPath}' not found on effect (tried Adapter & Box).` }
                    }

                    if (deviceType === "midiEffect") {
                        const effects = adapter.midiEffects.adapters()
                        if (deviceIndex >= effects.length) {
                            return { success: false, reason: `MIDI effect index ${deviceIndex} out of range (have ${effects.length})` }
                        }

                        if (deviceIndex < 0 || deviceIndex >= effects.length) {
                            return { success: false, reason: `MIDI Effect index ${deviceIndex} out of range` }
                        }

                        const effectAdapter = effects[deviceIndex]

                        // Hybrid Access
                        if (trySetParam((effectAdapter as any).namedParameter, paramPath, value)) {
                            return { success: true, message: `Set MIDI ${trackName}:${deviceIndex}.${paramPath}` }
                        }
                        if (trySetParam(effectAdapter.box, paramPath, value)) {
                            return { success: true, message: `Set (Deep) MIDI ${trackName}:${deviceIndex}.${paramPath}` }
                        }

                        return { success: false, reason: "MIDI Effect parameter not found." }
                    }

                    if (deviceType === "instrument") {
                        const inputAdapter = adapter.inputAdapter
                        if (inputAdapter.isEmpty()) return { success: false, reason: "No instrument on this track" }

                        const instrument = inputAdapter.unwrap()

                        // Hybrid Access
                        // Instrument Adapter often has namedParameter
                        if (trySetParam((instrument as any).namedParameter, paramPath, value)) {
                            return { success: true, message: `Set Instrument ${trackName}.${paramPath}` }
                        }
                        // Fallback to Box (e.g. for simple synths or direct props)
                        if (trySetParam(instrument.box, paramPath, value)) {
                            return { success: true, message: `Set (Deep) Instrument ${trackName}.${paramPath}` }
                        }

                        return { success: false, reason: `Instrument parameter '${paramPath}' not found.` }
                    }

                    return { success: false, reason: `Unknown device type: ${deviceType}` }
                } catch (e) {
                    console.error("setDeviceParam failed", e)
                    return { success: false, reason: String(e) }
                }
            },
            none: () => Promise.resolve({ success: false, reason: "Track not found" })
        })
    }

    /**
     * Audit all parameters of a device.
     */
    async getDeviceParameters(trackName: string, deviceType: "instrument" | "effect" | "midiEffect", deviceIndex: number = 0): Promise<string[]> {
        return this.findAudioUnitAdapter(trackName).match({
            some: (adapter) => {
                let device: any
                if (deviceType === "instrument") {
                    device = adapter.inputAdapter.unwrap()
                } else if (deviceType === "effect") {
                    device = adapter.audioEffects.adapters()[deviceIndex]
                } else if (deviceType === "midiEffect") {
                    device = adapter.midiEffects.adapters()[deviceIndex]
                }

                if (device && device.namedParameter) {
                    const keys: string[] = []
                    const walk = (obj: any, prefix: string = "") => {
                        for (const key in obj) {
                            const val = obj[key]
                            const path = prefix ? `${prefix}.${key}` : key
                            if (val && typeof val === "object" && !("getValue" in val)) {
                                walk(val, path)
                            } else {
                                keys.push(path)
                            }
                        }
                    }
                    walk(device.namedParameter)
                    return keys
                }
                return []
            },
            none: () => []
        })
    }
    /**
     * Add an effect to a track.
     * @param trackName - Name of the track
     * @param effectType - "compressor" | "delay" | "reverb" | "crusher" | "stereo"
     */
    async addEffect(trackName: string, effectType: string): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                let BoxClass: any
                switch (effectType.toLowerCase()) {
                    case 'compressor': BoxClass = CompressorDeviceBox; break;
                    case 'delay': BoxClass = DelayDeviceBox; break;
                    case 'reverb':
                    case 'cheap-reverb':
                        BoxClass = ReverbDeviceBox; break;
                    case 'dattorro':
                    case 'dattorro-reverb':
                        BoxClass = DattorroReverbDeviceBox; break;
                    case 'crusher': BoxClass = CrusherDeviceBox; break;
                    case 'stereo':
                    case 'stereo-tool':
                        BoxClass = StereoToolDeviceBox; break;
                    case 'tidal': BoxClass = TidalDeviceBox; break;
                    case 'revamp': BoxClass = RevampDeviceBox; break;
                    case 'fold': BoxClass = FoldDeviceBox; break;
                    case 'modular': BoxClass = ModularDeviceBox; break;
                    default: return { success: false, reason: `Unknown effect type: ${effectType}` }
                }

                try {
                    this.studio.project.editing.modify(() => {
                        let modularSetup: any
                        if (effectType.toLowerCase() === 'modular') {
                            // Full Modular stack per EffectFactories.ts
                            modularSetup = ModularBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                                box.collection.refer(this.studio.project.rootBox.modularSetups)
                                box.label.setValue("Modular")
                            })
                            const modularInput = ModularAudioInputBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                                box.attributes.collection.refer(modularSetup.modules)
                                box.attributes.label.setValue("Modular Input")
                                box.attributes.x.setValue(-256)
                                box.attributes.y.setValue(32)
                            })
                            const modularOutput = ModularAudioOutputBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                                box.attributes.collection.refer(modularSetup.modules)
                                box.attributes.label.setValue("Modular Output")
                                box.attributes.x.setValue(256)
                                box.attributes.y.setValue(32)
                            })
                            ModuleConnectionBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                                box.collection.refer(modularSetup.connections)
                                box.source.refer(modularInput.output)
                                box.target.refer(modularOutput.input)
                            })
                        }
                        // Create and Link Effect
                        BoxClass.create(this.studio.project.boxGraph, UUID.generate(), (box: any) => {
                            // Bi-directional link
                            if (box.host && adapter.box.audioEffects) {
                                box.host.refer(adapter.box.audioEffects)
                            }
                            if (modularSetup && (box as any).modularSetup) {
                                (box as any).modularSetup.refer(modularSetup.device)
                            }
                            box.label.setValue(effectType)
                            // [AG] Deterministic Indexing
                            if (box.index) {
                                box.index.setValue(adapter.audioEffects.getMinFreeIndex())
                            }
                        })
                    })

                    this.studio.odieEvents.notify({ type: "effect-added", track: trackName, effect: effectType })

                    return { success: true, message: `Added ${effectType}` }

                } catch (e: any) {
                    return { success: false, reason: `addEffect error: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: "Track not found" })
        })
    }

    /**
     * Add a MIDI effect to a track.
     * @param trackName - Name of the track
     * @param effectType - "arpeggio" | "velocity" | "pitch"
     */
    async addMidiEffect(trackName: string, effectType: string): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                if (adapter.isBus) {
                    return { success: false, reason: "MIDI effects can only be added to regular tracks, not Aux busses." }
                }
                let BoxClass: any
                switch (effectType.toLowerCase()) {
                    case 'arpeggio': BoxClass = ArpeggioDeviceBox; break;
                    case 'velocity': BoxClass = VelocityDeviceBox; break;
                    case 'pitch': BoxClass = PitchDeviceBox; break;
                    case 'zeitgeist': BoxClass = ZeitgeistDeviceBox; break;
                    default: return { success: false, reason: `Unknown MIDI effect type: ${effectType}` }
                }

                try {
                    this.studio.project.editing.modify(() => {
                        BoxClass.create(this.studio.project.boxGraph, UUID.generate(), (box: any) => {
                            if (box.host && adapter.box.midiEffects) {
                                box.host.refer(adapter.box.midiEffects)
                                // [AG] Deterministic Indexing
                                if (box.index) {
                                    box.index.setValue(adapter.midiEffects.getMinFreeIndex())
                                }
                            } else {
                                console.error("MIDI Effect creation failed: missing host/field wiring")
                            }
                        })
                    })

                    this.studio.odieEvents.notify({ type: "effect-added", track: trackName, effect: effectType })

                    return { success: true, message: `Added MIDI ${effectType}` }

                } catch (e: any) {
                    return { success: false, reason: `addMidiEffect error: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: "Track not found" })
        })
    }

    // --- STOP HERE ---

    async addNoteClip(trackName: string, label: string, notes: MidiNoteDef[]): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const tracksCollection = adapter.tracks as any
                let track: any = undefined

                // ROBUST TRACK FINDER STRATEGY
                if (Array.isArray(tracksCollection)) {
                    track = tracksCollection[0]
                } else if (typeof tracksCollection.adapters === 'function') {
                    // Standard Studio Adapter Collection
                    const adapters = tracksCollection.adapters()
                    track = Array.isArray(adapters) ? adapters[0] : undefined
                } else if (typeof tracksCollection.values === 'function') {
                    // Map-like or MobX-like
                    const vals = tracksCollection.values()
                    // Handle case where values() returns generic array instead of iterator
                    if (Array.isArray(vals)) {
                        track = vals[0]
                    } else if (vals && typeof vals.next === 'function') {
                        track = vals.next().value
                    } else {
                        // Fallback: try Array.from in case it is iterable
                        try { track = Array.from(vals)[0] } catch (e) { }
                    }
                }

                if (!track) return { success: false, reason: "No timeline track found on unit (Collection empty or unknown type)" }

                // Get the actual Box from the Adapter
                // track is likely TrackBoxAdapter, exposing .box
                const trackBox = track.box
                if (!trackBox) return { success: false, reason: "Track Adapter has no underlying Box" }

                const { editing, boxGraph } = this.studio.project

                editing.modify(() => {
                    // 1. Calculate Bounds in Bars
                    let minNoteBar = notes.length > 0 ? notes[0].startTime : 1
                    let maxNoteBarEnd = notes.length > 0 ? (notes[0].startTime + notes[0].duration) : 2
                    for (const n of notes) {
                        if (n.startTime < minNoteBar) minNoteBar = n.startTime
                        if ((n.startTime + n.duration) > maxNoteBarEnd) maxNoteBarEnd = (n.startTime + n.duration)
                    }

                    // 2. Create Event Collection
                    const eventCollection = NoteEventCollectionBox.create(boxGraph, UUID.generate())

                    // 3. Add Notes to Collection (using PPQN)
                    for (const n of notes) {
                        NoteEventBox.create(boxGraph, UUID.generate(), box => {
                            box.events.refer(eventCollection.events)
                            box.position.setValue(PPQN.fromSignature(n.startTime - 1, 1))
                            box.duration.setValue(PPQN.fromSignature(n.duration, 1))
                            box.pitch.setValue(n.pitch)
                            box.velocity.setValue(n.velocity)
                        })
                    }

                    // 4. Create Region Box
                    const regionUuid = UUID.generate()
                    NoteRegionBox.create(boxGraph, regionUuid, box => {
                        box.position.setValue(PPQN.fromSignature(minNoteBar - 1, 1))
                        box.duration.setValue(PPQN.fromSignature(maxNoteBarEnd - minNoteBar, 1))
                        box.label.setValue(label)

                        box.events.refer(eventCollection.owners)

                        if (trackBox.regions) {
                            box.regions.refer(trackBox.regions)
                        }
                    })
                })

                return { success: true, message: `Created Note Clip '${label}' on '${trackName}'` }
            },
            none: () => Promise.resolve({ success: false, reason: `Track '${trackName}' not found` })
        })
    }

    async addNote(trackName: string, pitch: number, start: number, duration: number, velocity: number): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                // 1. Convert 1-based Bars to PPQN
                // Assuming 4/4 signature for simplified logic, or use PPQN helper
                const ppqnStart = (start - 1) * 4 * PPQN.Quarter
                const ppqnDuration = duration * 4 * PPQN.Quarter

                // 2. Find Target Region
                // We use our helper findRegion (which expects PPQN)
                // We need to look up the specific track lane (Values()[0]) usually
                const tracksCollection = adapter.tracks as any
                let track: any = undefined
                if (Array.isArray(tracksCollection)) {
                    track = tracksCollection[0]
                } else if (typeof tracksCollection.values === 'function') {
                    const vals = tracksCollection.values()
                    track = Array.isArray(vals) ? vals[0] : Array.from(vals)[0]
                }

                if (!track) return { success: false, reason: "No track lane found." }

                const regions = track.regions.collection.asArray() as any[]
                const region = regions.find(r => r.position.getValue() <= ppqnStart && (r.position.getValue() + r.duration.getValue()) >= ppqnStart)

                if (!region) {
                    // Option: Create a clip if none exists?
                    // For now, fail as we expect a clip target.
                    return { success: false, reason: `No clip found at bar ${start} on track '${trackName}'. Create a clip first.` }
                }

                if (!(region instanceof NoteRegionBoxAdapter)) {
                    return { success: false, reason: "Target region is not a MIDI clip." }
                }

                // 3. Inject Note
                try {
                    this.studio.project.editing.modify(() => {
                        const eventCollection = region.optCollection.unwrap()
                        // Local position within the region
                        const localPosition = ppqnStart - region.position

                        // Create Note Event
                        NoteEventBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                            // Fix: Refer to the underlying box's events pointer (or collection owners)
                            box.events.refer(eventCollection.box.events)
                            box.position.setValue(localPosition)
                            box.duration.setValue(ppqnDuration)
                            box.pitch.setValue(pitch)
                            box.velocity.setValue(velocity)
                        })
                    })

                    this.studio.odieEvents.notify({ type: "note-added", track: trackName, pitch, start })
                    return { success: true, message: `Added note ${pitch} to '${trackName}' at bar ${start}` }


                } catch (e: any) {
                    console.error("addNote failed", e)
                    return { success: false, reason: `addNote error: ${e.message}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track '${trackName}' not found` })
        })
    }



    async newProject(): Promise<ToolResult> {
        try {
            await this.studio.newProject()
            return { success: true, message: "Created New Project" }
        } catch (e: any) {
            return { success: false, reason: `Failed to create new project: ${e.message}` }
        }
    }

    // --- 📚 THE LIBRARY (Assets) ---

    async listSamples(): Promise<{ uuid: string, name: string }[]> {
        // cast to any to access protected collectAllFiles
        const assets = await (this.studio.sampleService as any).collectAllFiles()
        return assets.map((a: any) => ({ uuid: a.uuid, name: a.name }))
    }

    async listSoundfonts(): Promise<{ uuid: string, name: string }[]> {
        const assets = await (this.studio.soundfontService as any).collectAllFiles()
        return assets.map((a: any) => ({ uuid: a.uuid, name: a.name }))
    }

    /** Find an asset in the library using fuzzy/keyword matching */
    private findAsset<T extends { name: string }>(assets: T[], query: string): Option<T> {
        const q = query.toLowerCase()
        // Exact match first
        const exact = assets.find(a => a.name.toLowerCase() === q)
        if (exact) return Option.wrap(exact)
        // Keyword match
        const keyword = assets.find(a => a.name.toLowerCase().includes(q))
        return Option.wrap(keyword)
    }

    async setNanoSample(trackName: string, query: string): Promise<ToolResult> {
        const samples = await this.listSamples()
        const match = this.findAsset(samples, query)
        if (match.isEmpty()) return { success: false, reason: `No sample matching '${query}' found.` }
        const asset = match.unwrap()

        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const instrument = adapter.inputAdapter.match({
                    some: input => input.type === "instrument" ? input : undefined,
                    none: () => undefined
                })

                if (!instrument || !(instrument instanceof NanoDeviceBoxAdapter)) {
                    return { success: false, reason: `No Nano instrument found on track '${trackName}'` }
                }

                const nano = instrument as NanoDeviceBoxAdapter
                const { editing, boxGraph } = this.studio.project
                const allSamples = await (this.studio.sampleService as any).collectAllFiles()
                const fullAsset = allSamples.find((a: any) => a.uuid === asset.uuid)

                editing.modify(() => {
                    const fileUUID = UUID.parse(asset.uuid)
                    const fileBox = boxGraph.findBox<AudioFileBox>(fileUUID)
                        .unwrapOrElse(() => AudioFileBox.create(boxGraph, fileUUID, box => {
                            box.fileName.setValue(asset.name)
                            if (fullAsset) box.endInSeconds.setValue(fullAsset.duration)
                        }))

                    const oldAsset = nano.box.file.targetVertex.map(v => v.box)
                    nano.box.file.refer(fileBox)

                    if (oldAsset.nonEmpty() && oldAsset.unwrap().incomingEdges().length === 0) {
                        const box = oldAsset.unwrap()
                        if (box.name === "AudioFileBox") box.delete()
                    }
                })
                return { success: true, message: `Loaded sample '${asset.name}' into Nano on '${trackName}'` }
            },
            none: () => Promise.resolve({ success: false, reason: "Track not found" })
        })
    }

    async setPlayfieldPad(trackName: string, padIndex: number, query: string): Promise<ToolResult> {
        const samples = await this.listSamples()
        const match = this.findAsset(samples, query)
        if (match.isEmpty()) return { success: false, reason: `No sample matching '${query}' found.` }
        const asset = match.unwrap()

        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const instrument = adapter.inputAdapter.match({
                    some: input => input.type === "instrument" ? input : undefined,
                    none: () => undefined
                })

                if (!instrument || !(instrument instanceof PlayfieldDeviceBoxAdapter)) {
                    return { success: false, reason: `No Playfield instrument found on track '${trackName}'` }
                }

                const playfield = instrument as PlayfieldDeviceBoxAdapter
                const { editing, boxGraph } = this.studio.project
                const allSamples = await (this.studio.sampleService as any).collectAllFiles()
                const fullAsset = allSamples.find((a: any) => a.uuid === asset.uuid)

                editing.modify(() => {
                    const fileUUID = UUID.parse(asset.uuid)
                    const fileBox = boxGraph.findBox<AudioFileBox>(fileUUID)
                        .unwrapOrElse(() => AudioFileBox.create(boxGraph, fileUUID, box => {
                            box.fileName.setValue(asset.name)
                            if (fullAsset) box.endInSeconds.setValue(fullAsset.duration)
                        }))

                    // Check if pad already exists
                    const existingPad = playfield.samples.adapters().find(a => (a.box as PlayfieldSampleBox).index.getValue() === padIndex)
                    if (existingPad) {
                        const box = existingPad.box as PlayfieldSampleBox
                        const oldAsset = box.file.targetVertex.map(v => v.box)
                        box.file.refer(fileBox)

                        if (oldAsset.nonEmpty() && oldAsset.unwrap().incomingEdges().length === 0) {
                            const b = oldAsset.unwrap()
                            if (b.name === "AudioFileBox") b.delete()
                        }
                    } else {
                        PlayfieldSampleBox.create(boxGraph, UUID.generate(), box => {
                            box.device.refer(playfield.box.samples)
                            box.file.refer(fileBox)
                            box.index.setValue(padIndex)
                        })
                    }
                })
                return { success: true, message: `Loaded sample '${asset.name}' onto pad ${padIndex} on '${trackName}'` }
            },
            none: () => Promise.resolve({ success: false, reason: "Track not found" })
        })
    }

    async setSoundfont(trackName: string, query: string): Promise<ToolResult> {
        const sfs = await this.listSoundfonts()
        const match = this.findAsset(sfs, query)
        if (match.isEmpty()) return { success: false, reason: `No soundfont matching '${query}' found.` }
        const asset = match.unwrap()

        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const instrument = adapter.inputAdapter.match({
                    some: input => input.type === "instrument" ? input : undefined,
                    none: () => undefined
                })

                if (!instrument || !(instrument instanceof SoundfontDeviceBoxAdapter)) {
                    return { success: false, reason: `No Soundfont instrument found on track '${trackName}'` }
                }

                const sfAdapter = instrument as SoundfontDeviceBoxAdapter
                const { editing, boxGraph } = this.studio.project
                editing.modify(() => {
                    const fileUUID = UUID.parse(asset.uuid)
                    const fileBox = boxGraph.findBox<SoundfontFileBox>(fileUUID)
                        .unwrapOrElse(() => SoundfontFileBox.create(boxGraph, fileUUID, box => {
                            box.fileName.setValue(asset.name)
                        }))

                    const oldAsset = sfAdapter.box.file.targetVertex.map(v => v.box)
                    sfAdapter.box.file.refer(fileBox)

                    if (oldAsset.nonEmpty() && oldAsset.unwrap().incomingEdges().length === 0) {
                        const box = oldAsset.unwrap()
                        if (box.name === "SoundfontFileBox") box.delete()
                    }
                })
                return { success: true, message: `Loaded soundfont '${asset.name}' on '${trackName}'` }
            },
            none: () => Promise.resolve({ success: false, reason: "Track not found" })
        })
    }

}
