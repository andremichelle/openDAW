import { Color, Option, Parameter, Primitive, isDefined, Nullable, UUID } from "@opendaw/lib-std"
import { TimeBase, Interpolation, PPQN } from "@opendaw/lib-dsp"
import { Field, PointerField, Box, Int32Field } from "@opendaw/lib-box"
import {
    RegionEditing,
    AudioUnitBoxAdapter,
    AnyRegionBoxAdapter,
    NoteRegionBoxAdapter,
    AudioRegionBoxAdapter,
    ValueRegionBoxAdapter,
    TrackType,
    NanoDeviceBoxAdapter,
    PlayfieldDeviceBoxAdapter,
    SoundfontDeviceBoxAdapter,
    AutomatableParameterFieldAdapter,
    AudioBusBoxAdapter,
    AudioBusFactory,
    InstrumentFactories,
    InstrumentFactory,
    TrackBoxAdapter
} from "@opendaw/studio-adapters"
import { Workspace } from "@/ui/workspace/Workspace"
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
    PlayfieldSampleBox,
    AudioFileBox,
    SoundfontFileBox,
    TidalDeviceBox,
    RevampDeviceBox,
    FoldDeviceBox,
    ModularDeviceBox,
    ArpeggioDeviceBox,
    VelocityDeviceBox,
    PitchDeviceBox,
    DattorroReverbDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import { AudioUnitType, IconSymbol, Pointers } from "@opendaw/studio-enums"
import type { StudioService } from "../../../service/StudioService"

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

// Local helper type for Boxes that have a position (Common Interface)
type RegionBoxWithPosition =
    | NoteRegionBox
    | AudioRegionBox
    | ValueRegionBox



/** Structured tool result for better error reporting */
export interface ToolResult {
    success: boolean
    reason?: string
    message?: string // Added for consistency with success messages
}

import { AnalysisResult, RegionAnalysis } from "../OdieTypes"

// ═══════════════════════════════════════════════════════════════════════════
// ODIE LOCAL TYPE DEFINITIONS
// These types describe the shapes of upstream objects as accessed by Odie.
// ═══════════════════════════════════════════════════════════════════════════

/** Information about a track adapter, including its type and associated box. */
interface TrackAdapterInfo {
    address: unknown
    constructor: { name: string }
}

/** Represents a modular setup, including its input, output, and connections. */
interface ModularSetup {
    modules: Field<Pointers.ModuleCollection>
    connections: Field<Pointers.ConnectionCollection>
    device: Field<Pointers.ModularSetup>
}

/** A device box that can be hosted within a track. */
interface HostableDeviceBox {
    host?: { refer(target: unknown): void }
    label: { setValue(value: string): void }
    index?: { setValue(value: number): void }
}

// Extended parameter type to support legacy min/max properties checking
type OdieParameter<T extends Primitive = Primitive> = Parameter<T> & {
    minValue?: number
    maxValue?: number
    setValue?(value: T): void
    field?: OdieParameter<T> // For wrapped parameters
}

// Alias for device adapter with params, used in casting
type WithNamedParams = DeviceAdapterWithParams

/** Parameter metadata extracted for AI response */
interface ParameterInfo {
    value: number | boolean | string
    min?: number
    max?: number
}

/** Recursive parameter tree (can have nested groups like osc1.wave) */
interface ParameterTree {
    [key: string]: ParameterInfo | ParameterTree
}

/** Effect/MIDI Effect details for getTrackDetails */
interface EffectDetails {
    index: number
    type: string
    label: string
    enabled: boolean
    parameters: ParameterTree
}

/** Instrument details for getTrackDetails */
interface InstrumentDetails {
    type: string
    label: string
    parameters: ParameterTree
}

/** Full track details returned by getTrackDetails */
interface TrackDetails {
    track: string
    type: unknown
    mixer: {
        volume: number
        panning: number
        mute: boolean
        solo: boolean
    }
    midiEffects: EffectDetails[]
    audioEffects: EffectDetails[]
    instrument: InstrumentDetails | null
}

/** Device adapter with namedParameter (effects, instruments) */
interface DeviceAdapterWithParams {
    namedParameter: Record<string, OdieParameter | Record<string, OdieParameter>>
    constructor: { name: string }
}

/**
 * Odie Studio Control
 * Validated Bridge for AI-to-Studio interactions.
 */
import { OdieTransport } from "./OdieTransport"

export class OdieAppControl {
    readonly transport: OdieTransport
    constructor(private studio: StudioService) {
        this.transport = new OdieTransport(studio)
    }

    // --- Arrangement ---

    async createProject(): Promise<boolean> {
        const result = await this.newProject()
        return result.success
    }

    listTracks(): string[] {
        if (!this.studio.hasProfile) return []
        // Return names of all tracks
        return this.studio.project.rootBoxAdapter.audioUnits.adapters()
            .filter(a => a.box.isAttached())
            .map(a => a.input.label.unwrapOrElse("Untitled"))
    }

    async addTrack(type: string, name: string = "New Track"): Promise<ToolResult> {
        if (!this.studio.hasProfile) {
            return { success: false, reason: "No active project loaded." }
        }

        // Type normalization with Semantic Mapping (Common Sense)
        const t = (type || "synth").toLowerCase()
        let factory: InstrumentFactory | undefined

        // Intent-to-Native Mapping
        if (t === 'synth' || t === 'bass' || t === 'sub-bass') factory = InstrumentFactories.Nano
        else if (t === 'drums' || t === 'pads' || t === 'sample pads' || t === 'percussion') factory = InstrumentFactories.Playfield
        else if (t === 'keys' || t === 'piano' || t === 'orchestral' || t === 'strings') factory = InstrumentFactories.Soundfont
        else if (t === 'vaporisateur' || t === 'granular' || t === 'ambient') factory = InstrumentFactories.Vaporisateur
        else if (t === 'nano') factory = InstrumentFactories.Nano
        else if (t === 'tape' || t === 'lo-fi') factory = InstrumentFactories.Tape
        else if (t === 'midiout' || t === 'midi-output') factory = InstrumentFactories.MIDIOutput
        else if (t === "instrument") { type = "nano"; factory = InstrumentFactories.Nano; }
        else if (t !== 'audio') {
            // Fallback: Check if 't' matches a factory name directly
            const factories = Object.values(InstrumentFactories.Named)
            const match = factories.find(f => {
                return "defaultName" in f && (f as NamedInstrumentFactory).defaultName.toLowerCase() === t
            })

            if (match) {
                factory = match as InstrumentFactory
            } else {
                return { success: false, reason: `Unknown track type: '${type}'. Try: synth, drums, keys, lo-fi, granular, or audio.` }
            }
        }

        try {
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
                    new Color(74, 144, 226) // #4a90e2 (HSL: 210, 66%, 59%)
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
                    return { success: false, reason: "Source must be a regular track" }
                }
                const root = this.studio.project.rootBoxAdapter
                const targetBusAdapter = root.audioBusses.adapters().find(a => a.labelField.getValue() === auxName)

                if (!targetBusAdapter) {
                    return Promise.resolve({ success: false, reason: `Aux Bus "${auxName}" not found` })
                }

                try {
                    this.studio.project.editing.modify(() => {
                        AuxSendBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                            box.audioUnit.refer(sourceAdapter.box.auxSends)
                            box.sendGain.setValue(db)
                            box.targetBus.refer(targetBusAdapter.box.input)
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






    private findAudioUnit(name: string): Option<AudioUnitBox> {
        return this.findAudioUnitAdapter(name).map(a => a.box)
    }

    // --- Transport ---

    async play(): Promise<boolean> {
        try {
            await this.transport.play()
            return true
        } catch (e) {
            console.error("[Odie] Play failed", e)
            return false
        }
    }

    async stop(): Promise<boolean> {
        try {
            await this.transport.stop()
            return true
        } catch (e) {
            console.error("[Odie] Stop failed", e)
            return false
        }
    }

    async record(countIn: boolean = true): Promise<boolean> {
        try {
            this.transport.record(countIn)
            return true
        } catch (e) {
            console.error("[Odie] Record failed", e)
            return false
        }
    }

    async stopRecording(): Promise<boolean> {
        try {
            this.transport.stopRecording()
            return true
        } catch (e) {
            console.error("[Odie] Stop Recording failed", e)
            return false
        }
    }

    async setCountIn(bars: number): Promise<boolean> {
        // Range Safety (1 to 4 bars is reasonable standard)
        if (bars < 1) bars = 1
        if (bars > 4) bars = 4

        console.warn("[Odie] CountIn not supported by current Engine Transport Facade.")
        return false
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

    async setBpm(bpm: number): Promise<ToolResult> {
        if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 20 || bpm > 999) {
            return { success: false, reason: "Invalid BPM. Must be between 20 and 999." }
        }
        console.log(`[Odie] Setting BPM to ${bpm}...`)
        const success = this.transport.setBpm(bpm)
        if (!success) {
            return { success: false, reason: "Failed to set BPM (Transport rejected value)." }
        }
        return { success: true, message: `BPM set to ${bpm}` }
    }

    async setTimeSignature(numerator: number, denominator: number): Promise<ToolResult> {
        if (typeof numerator !== 'number' || !Number.isFinite(numerator) || numerator < 1 || numerator > 32) {
            return { success: false, reason: "Invalid time signature numerator." }
        }
        if (typeof denominator !== 'number' || ![1, 2, 4, 8, 16, 32].includes(denominator)) {
            return { success: false, reason: "Invalid time signature denominator (must be power of 2)." }
        }
        console.log(`[Odie] Setting Time Signature to ${numerator}/${denominator}...`)
        const success = this.transport.setTimeSignature(numerator, denominator)
        if (!success) {
            return { success: false, reason: "Failed to set time signature (Transport rejected values)." }
        }
        return { success: true, message: `Time signature set to ${numerator}/${denominator}` }
    }

    // --- Mixer ---

    async setVolume(trackName: string, db: number): Promise<ToolResult> {
        if (typeof db !== 'number' || isNaN(db)) {
            return { success: false, reason: "Invalid volume value. Must be a number." }
        }
        // Range Safety
        if (db > 6.0) db = 6.0

        return this.findAudioUnit(trackName).match<Promise<ToolResult>>({
            some: async (box) => {
                try {
                    this.studio.project.editing.modify(() => {
                        box.volume.setValue(db)
                    })
                    return { success: true }
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e)
                    return { success: false, reason: `setVolume failed: ${msg}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async setPan(trackName: string, pan: number): Promise<ToolResult> {
        if (typeof pan !== 'number' || isNaN(pan)) {
            return { success: false, reason: "Invalid pan value. Must be a number." }
        }
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
                } catch (e: unknown) {
                    return { success: false, reason: `setPan failed: ${e instanceof Error ? e.message : String(e)}` }
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
                } catch (e: unknown) {
                    return { success: false, reason: `mute failed: ${e instanceof Error ? e.message : String(e)}` }
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
                } catch (e: unknown) {
                    return { success: false, reason: `solo failed: ${e instanceof Error ? e.message : String(e)}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    // --- View ---

    async switchScreen(screen: "arrangement" | "scene"): Promise<boolean> {
        try {
            // Map Odie terms to Workspace screen keys
            const key = screen === "arrangement" ? "default" : (screen as string)
            this.studio.switchScreen(key as Nullable<Workspace.ScreenKeys>)
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

    // --- Arrangement Config ---

    async deleteTrack(name: string): Promise<boolean> {
        console.log(`[OdieAppControl] deleteTrack requested for: '${name}'`);
        const result = await this.findAudioUnit(name).match({
            some: async (box) => {
                try {
                    console.log(`[OdieAppControl] Found audio unit for deletion.`);
                    this.studio.project.editing.modify(() => {
                        this.studio.project.api.deleteAudioUnit(box)
                    })

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

    // --- Editing ---

    async splitRegion(trackName: string, time?: number): Promise<ToolResult> {
        // Default to current playhead if no time specified
        // FIX: Convert 1-based Bar to PPQN (0-based) using robust helper
        const splitTime = isDefined(time) ? PPQN.fromSignature(time - 1, 1) : this.transport.position

        return this.findRegion(trackName, splitTime).match<Promise<ToolResult>>({
            some: async (region) => {
                try {
                    this.studio.project.editing.modify(() => {
                        RegionEditing.cut(region, splitTime, false)
                    })
                    return { success: true, message: `Split region at ${splitTime.toFixed(2)} PPQN` }
                } catch (e: unknown) {
                    console.error("Split failed", e)
                    return { success: false, reason: `Split failed: ${e instanceof Error ? e.message : String(e)}` }
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
                        // Safe cast to known RegionBox types that have 'position'
                        (region.box as RegionBoxWithPosition).position.setValue(ppqnNewTime)
                    })
                    return { success: true }
                } catch (e: unknown) {
                    console.error("Move failed", e)
                    return { success: false, reason: `Move failed: ${e instanceof Error ? e.message : String(e)}` }
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
                } catch (e: unknown) {
                    console.error("Copy failed", e)
                    return { success: false, reason: `Copy failed: ${e instanceof Error ? e.message : String(e)}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `No region found at time ${time} on track "${trackName}"` })
        })
    }

    async getMidiNotes(trackName: string): Promise<{ notes: MidiNoteDef[], logs: string[] }> {
        return this.findAudioUnitAdapter(trackName).match({
            some: async (adapter) => {
                const logs: string[] = []
                const log = (msg: string) => {
                    console.log(msg)
                    logs.push(msg)
                }

                const tracks = Array.from(adapter.tracks.values())
                log(`[Odie] getMidiNotes: Adapter "${trackName}" has ${tracks.length} tracks.`)

                let allNotes: MidiNoteDef[] = []

                tracks.forEach((track, index) => {
                    const regionCount = track.regions.collection.asArray().length
                    log(`[Odie] Track ${index}: ${regionCount} regions.`)

                    track.regions.collection.asArray().forEach((r) => {
                        const typeName = r.constructor.name
                        log(`[Odie] Track ${index} Region at ${r.position}: ${typeName}`)
                        if (r instanceof NoteRegionBoxAdapter) {
                            const optCollection = r.optCollection
                            if (optCollection.nonEmpty()) {
                                const events = optCollection.unwrap().events.asArray()
                                log(`[Odie] .. found ${events.length} notes.`)
                                events.forEach(e => {
                                    allNotes.push({
                                        pitch: e.pitch,
                                        startTime: (r.position + e.position) / 4.0 + 1,
                                        duration: e.duration / 4.0,
                                        velocity: e.velocity
                                    })
                                })
                            }
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
        const adapterMeta = this.findAudioUnitAdapter(trackName)
        if (adapterMeta.isEmpty()) return { success: false, reason: `Track "${trackName}" not found` }
        const adapter = adapterMeta.unwrap()

        const track = this.findFirstTrack(adapter)
        if (!track) return { success: false, reason: `Track "${trackName}" has no note lanes.` }
        if (!isDefined(track.box) || !isDefined(track.box.regions)) return { success: false, reason: `Track "${trackName}" has no regions collection.` }

        try {
            if (notes.length === 0) return { success: true }

            // Convert first note startTime (1-based Bar) to PPQN
            const firstNoteTime = PPQN.fromSignature(notes[0].startTime - 1, 1)

            let region = (track.regions.collection.asArray() as AnyRegionBoxAdapter[])
                .find((r) => r instanceof NoteRegionBoxAdapter && r.position <= firstNoteTime && (r.position + r.duration) > firstNoteTime) as NoteRegionBoxAdapter | undefined

            if (!isDefined(region)) {
                // Auto-Create Clip (MVP: 4 bar clip quantized to bar)
                const startPPQN = Math.floor(firstNoteTime / 4) * 4
                const durationPPQN = 16.0 // 4 bars

                this.studio.project.editing.modify(() => {
                    const collection = NoteEventCollectionBox.create(this.studio.project.boxGraph, UUID.generate())
                    NoteRegionBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                        box.position.setValue(startPPQN)
                        box.duration.setValue(durationPPQN)
                        box.loopDuration.setValue(durationPPQN)
                        box.regions.refer(track.box.regions)
                        box.events.refer(collection.owners)
                    })
                })

                // Refetch to get adapter
                region = (track.regions.collection.asArray() as AnyRegionBoxAdapter[])
                    .find((r) => r instanceof NoteRegionBoxAdapter && r.position === startPPQN) as NoteRegionBoxAdapter | undefined
            }

            if (!isDefined(region)) return { success: false, reason: `No MIDI region found and failed to create one.` }

            const targetRegion = region!
            this.studio.project.editing.modify(() => {
                const collection = targetRegion.optCollection.unwrap()
                const regionPos = targetRegion.position

                this.studio.odieEvents.notify({ type: "region-created", track: trackName, time: regionPos })

                notes.forEach(note => {
                    const noteStart = PPQN.fromSignature(note.startTime - 1, 1) - regionPos
                    const noteDuration = PPQN.fromSignature(note.duration, 1)

                    NoteEventBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                        box.events.refer(collection.box.events)
                        box.position.setValue(noteStart)
                        box.duration.setValue(noteDuration)
                        box.pitch.setValue(note.pitch)
                        // Fix: Velocity is passed as raw value (0-127)
                        box.velocity.setValue(note.velocity)
                    })
                })
            })

            return { success: true, message: `Added ${notes.length} notes to '${trackName}'` }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e)
            return { success: false, reason: `addMidiNotes failed: ${msg}` }
        }
    }

    async addAutomationPoint(trackName: string, param: "volume" | "pan", time: number, value: number): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                // 1. Resolve Parameter Field
                const box = adapter.box
                let field: typeof box.volume | typeof box.panning | undefined
                if (param === "volume") field = box.volume
                else if (param === "pan") field = box.panning
                else return { success: false, reason: `Invalid automation param: ${param}` }

                try {
                    let lane = adapter.tracks.controls(field).unwrapOrUndefined()
                    if (!lane) {
                        this.studio.project.editing.modify(() => {
                            adapter.tracks.create(TrackType.Value, field)
                        })

                        // Refresh
                        lane = adapter.tracks.controls(field).unwrapOrUndefined()
                    }
                    if (!lane) return { success: false, reason: "Automation lane missing after creation attempt." }

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

                    // Signal Dispatch
                    this.studio.odieEvents.notify({ type: "param-changed", track: trackName, param, value })
                    return { success: true }

                } catch (e: unknown) {
                    console.error("Automation Logic Failed", e)
                    return { success: false, reason: `Automation error: ${e instanceof Error ? e.message : String(e)}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    // --- Export ---

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




    // --- Project ---

    async loadProject(): Promise<boolean> {
        return this.studio.browseLocalProjects().then(() => true).catch(() => false)
    }

    async loadTemplate(name: string): Promise<boolean> {
        try {
            await this.studio.loadTemplate(name)
            // Signal Dispatch
            this.studio.odieEvents.notify({ type: "project-loaded", name: name })
            return true
        } catch (e) {
            console.error("Failed to load template", e)
            return false
        }
    }

    // --- Analysis ---

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
                        const target = (box as unknown as { target?: { targetVertex?: { unwrap?(): { box: { label: { getValue(): string } } } } } }).target
                        const targetBox = target?.targetVertex?.unwrap?.()?.box

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
        } catch (e: unknown) {
            console.error("❌ Odie: Save Failed", e)
            return { success: false, reason: e instanceof Error ? e.message : String(e) }
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
            const trackResult = await this.addTrack("audio", trackName)
            if (!trackResult.success) {
                return { success: false, reason: trackResult.reason || `Failed to create track '${trackName}'` }
            }

            // 4. Create Boxes & Region
            const adapterMeta = this.findAudioUnitAdapter(trackName)
            if (adapterMeta.isEmpty()) throw new Error(`Could not find adapter for created track ${trackName}`)
            const adapter = adapterMeta.unwrap()

            const track = this.findFirstTrack(adapter)
            if (!track) throw new Error("Created audio unit has no track lane (Collection empty or unknown type)")

            const trackBox = track.box
            if (!trackBox) throw new Error("Track Adapter has no underlying TrackBox")

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
                    box.loopDuration.setValue(durationSeconds)
                    box.position.setValue(0)
                    // Explicitly set TimeBase to Seconds for Audio Regions
                    box.timeBase.setValue(TimeBase.Seconds)

                    // Link Events Collection (Crucial Fix)
                    box.events.refer(valueEventCollectionBox.owners)

                    // D. Link to Track (Robust Graph Linking)
                    const trackAdapter = (track as unknown as { box: { regions: unknown } })
                    if (trackAdapter.box.regions) {
                        box.regions.refer(trackAdapter.box.regions as any)
                    } else {
                        console.warn("TrackBox has no regions collection to refer to")
                    }
                })
            })

            return { success: true, message: `Imported audio to track '${trackName}'` }

        } catch (e: unknown) {
            console.error("❌ Odie: Import Failed", e)
            return { success: false, reason: e instanceof Error ? e.message : String(e) }
        }
    }

    private createSineWaveWav(duration: number, frequency: number, sampleRate: number): ArrayBuffer {
        const numFrames = Math.floor(duration * sampleRate);
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

                    const regions: RegionAnalysis[] = track.regions.collection.asArray().map(r => {
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

                    const analysisData: AnalysisResult = {
                        track: trackName,
                        regions: regions
                    }
                    const resultString = JSON.stringify(analysisData)

                    // Signal Dispatch
                    this.studio.odieEvents.notify({ type: "analysis-complete", track: trackName, result: analysisData })

                    return resultString

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
            root.audioUnits.adapters().forEach((au) => {
                let tracks: TrackAdapterInfo[] = []
                try {
                    const tracksField = (au as unknown as { tracks?: { adapters?: () => unknown[], values?: () => unknown[] } }).tracks
                    if (tracksField && typeof tracksField.adapters === 'function') {
                        tracks = tracksField.adapters() as TrackAdapterInfo[]
                    } else if (tracksField && typeof tracksField.values === 'function') {
                        tracks = Array.from(tracksField.values()) as TrackAdapterInfo[]
                    }
                } catch (_e) { /* Ignore iter error */ }

                tracks.forEach((t) => {
                    summary += `- ${t.constructor.name} (Address: ${t.address})\n`
                })
            })
        }

        return summary
    }

    /**
     * Verification Loop Tool
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

    public findAudioUnitAdapter(name: string): Option<AudioUnitBoxAdapter> {
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
                label = a.labelField.getValue()
            }
            const labelTrim = label.trim()
            return a.box.isAttached() && (labelTrim === targetName || labelTrim.toLowerCase() === targetName.toLowerCase())
        })

        if (!match) {
            // Debug logging for failures
            if (name !== "") {
                const labels = allAdapters.map(a => {
                    if (a instanceof AudioUnitBoxAdapter) return `[Unit] ${a.label}`
                    if (a instanceof AudioBusBoxAdapter) return `[Bus/Device] ${a.labelField.getValue()}`
                    return `[Unknown] ${(a as { address?: { toString(): string } }).address?.toString() ?? "no address"}`
                })
                console.warn(`[Odie] findAudioUnitAdapter: No match for "${name}". Available:`, labels)
            }
            return Option.None
        }

        if ('audioUnitBoxAdapter' in match && typeof match.audioUnitBoxAdapter === 'function') {
            return Option.wrap(match.audioUnitBoxAdapter())
        }
        return Option.wrap(match as AudioUnitBoxAdapter)
    }

    /**
     * Resolves a parameter path (e.g. "Kick/volume" or "Kick/Reverb/mix") to a real parameter adapter.
     * Used by GenUI to bind AI-generated knobs to actual engine parameters.
     */
    public resolveParameter(path: string): AutomatableParameterFieldAdapter<number> | null {
        try {
            const parts = path.split('/')
            // If only 1 part ("volume"), assume selected track? No, too dangerous. Require Track/Param.
            // Exception: Master track params maybe?
            if (parts.length < 2) return null

            const trackName = parts[0]
            const tail = parts.slice(1)

            const trackAdapter = this.findAudioUnitAdapter(trackName).match({
                some: (a) => a,
                none: () => null
            })

            if (!trackAdapter) return null

            // Case A: Track Parameter (e.g. "Kick/volume")
            if (tail.length === 1) {
                const paramName = tail[0].toLowerCase()
                // 1. Standard Parameters (via namedParameter if available)
                if ('namedParameter' in trackAdapter) {
                    const adapter = trackAdapter as unknown as DeviceAdapterWithParams
                    if (paramName === 'volume') return adapter.namedParameter.volume as unknown as AutomatableParameterFieldAdapter<number>
                    // Fix: Use .panning instead of .pan to match real AudioUnit adapters
                    if (paramName === "pan" || paramName === "panning") return trackAdapter.box.panning as unknown as AutomatableParameterFieldAdapter<number>
                    if (paramName === 'mute') return adapter.namedParameter.mute as unknown as AutomatableParameterFieldAdapter<number>
                    if (paramName === 'solo') return adapter.namedParameter.solo as unknown as AutomatableParameterFieldAdapter<number>
                }
                // 2. Direct Property fallback
                const param = (trackAdapter as unknown as Record<string, unknown>)[paramName]
                if (param && typeof (param as { setValue?: unknown }).setValue === 'function') {
                    return param as AutomatableParameterFieldAdapter<number>
                }
                return null
            }

            // Case B: Device Parameter (e.g. "Kick/Reverb/mix")
            if (tail.length >= 2) {
                const deviceName = tail[0]
                const paramName = tail[1]

                // Search Audio Effects
                const effects = trackAdapter.audioEffects?.adapters() || []
                const foundEffect = effects.find((eff) => {
                    const label = eff.labelField?.getValue() ?? ''
                    return label.includes(deviceName)
                })

                if (foundEffect && 'namedParameter' in foundEffect) {
                    const effectWithParams = foundEffect as unknown as DeviceAdapterWithParams
                    // Try direct property access on namedParameter
                    const param = effectWithParams.namedParameter[paramName]
                    if (param && 'getValue' in param) {
                        return param as unknown as AutomatableParameterFieldAdapter<number>
                    }
                }
            }

            return null
        } catch (e) {
            console.error("[OdieAppControl] resolveParameter failed", e)
            return null
        }
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
                    const details: TrackDetails = {
                        track: trackName,
                        type: adapter.type,
                        mixer: {
                            volume: adapter.namedParameter.volume.getValue() as number,
                            panning: adapter.namedParameter.panning.getValue() as number,
                            mute: adapter.namedParameter.mute.getValue() as boolean,
                            solo: adapter.namedParameter.solo.getValue() as boolean
                        },
                        midiEffects: [],
                        audioEffects: [],
                        instrument: null
                    }

                    // Helper to extract param metadata recursively
                    const extractParams = (obj: Record<string, unknown>, prefix = ""): ParameterTree => {
                        const result: ParameterTree = {}
                        if (!obj) return result

                        for (const [key, val] of Object.entries(obj)) {
                            if (!val) continue
                            const path = prefix ? `${prefix}.${key}` : key

                            // Check if it's a ParameterAdapter (has getValue)
                            if (typeof val === 'object' && 'getValue' in val) {
                                const p = val as OdieParameter
                                result[key] = {
                                    value: (p.getValue() ?? "") as string | number | boolean,
                                    min: p.minValue,
                                    max: p.maxValue
                                }
                            }
                            // Recurse for nested objects (like osc1.wave)
                            else if (typeof val === 'object' && val !== null) {
                                const nested = extractParams(val as Record<string, unknown>, path)
                                // Merge or nest? For setDeviceParam we use dot notation.
                                // Let's keep structure but leaf nodes are rich objects.
                                if (Object.keys(nested).length > 0) {
                                    result[key] = nested
                                }
                            }
                        }
                        return result
                    }


                    const audioEffects = adapter.audioEffects.adapters()
                    audioEffects.forEach((effect, index) => {
                        const effectInfo: EffectDetails = {
                            index,
                            type: effect.constructor.name.replace('DeviceBoxAdapter', ''),
                            label: effect.labelField.getValue(),
                            enabled: effect.enabledField.getValue(),
                            parameters: {}
                        }



                        // Extract named parameters if available
                        if ('namedParameter' in effect && effect.namedParameter) {
                            effectInfo.parameters = extractParams(effect.namedParameter as Record<string, unknown>)
                        }

                        details.audioEffects.push(effectInfo)
                    })

                    // Extract MIDI effects
                    const midiEffects = adapter.midiEffects.adapters()
                    midiEffects.forEach((effect, index) => {
                        const effectInfo: EffectDetails = {
                            index,
                            type: effect.constructor.name.replace('DeviceBoxAdapter', ''),
                            label: effect.labelField.getValue(),
                            enabled: effect.enabledField.getValue(),
                            parameters: {}
                        }

                        if ('namedParameter' in effect && effect.namedParameter) {
                            effectInfo.parameters = extractParams(effect.namedParameter as Record<string, unknown>)
                        }

                        details.midiEffects.push(effectInfo)
                    })

                    // Extract instrument info
                    const inputAdapter = adapter.inputAdapter
                    if (inputAdapter && inputAdapter.nonEmpty()) {
                        const instrument = inputAdapter.unwrap()
                        if ('namedParameter' in instrument) {
                            const instrInfo: InstrumentDetails = {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                type: instrument.constructor.name.replace('DeviceBoxAdapter', '') as any,
                                label: instrument.labelField?.getValue() || 'Unknown',
                                parameters: {}
                            }

                            const params = (instrument as DeviceAdapterWithParams).namedParameter
                            if (params) {
                                instrInfo.parameters = extractParams(params as Record<string, unknown>)
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
     * @param deviceType - "effect" | "instrument" | "mixer" | "midiEffect"
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
                    const applyValue = (deviceAdapter: Record<string, OdieParameter>, paramName: string, numericValue: number): ToolResult => {
                        const param = deviceAdapter[paramName]
                        if (!param) {
                            const available = Object.keys(deviceAdapter || {}).join(", ")
                            console.warn(`[Odie] Param "${paramName}" not found on target. Available: ${available}`)
                            return { success: false, reason: `Param not found: ${paramPath}. Available: ${available}` }
                        }

                        let setter: ((v: number) => void) | undefined

                        if (typeof param.setValue === 'function') {
                            setter = (v) => param.setValue!(v)
                        } else if (param.field && typeof param.field.setValue === 'function') {
                            const wrappedParam = param.field
                            setter = (v) => wrappedParam.setValue!(v)
                        }

                        if (setter) {
                            try {
                                // Critical: Must be in editing transaction
                                this.studio.project.editing.modify(() => {
                                    setter!(numericValue)
                                })
                                return { success: true, reason: `${trackName} ${deviceType} ${paramPath} set to ${numericValue.toFixed(2)}` }
                            } catch (err: unknown) {
                                console.error("Mutation failed", err)
                                const errorMsg = err instanceof Error ? err.message : String(err)
                                return { success: false, reason: `Mutation failed: ${errorMsg}` }
                            }
                        }

                        return { success: false, reason: `Param ${paramPath} is not controllable (no setValue)` }
                    }




                    if (deviceType === "mixer") {
                        const mixerParams = (adapter as unknown as WithNamedParams).namedParameter
                        return applyValue(mixerParams as Record<string, OdieParameter>, paramPath, value)
                    }

                    if (deviceType === "effect") {
                        const effects = adapter.audioEffects.adapters()

                        if (deviceIndex < 0 || deviceIndex >= effects.length) {
                            return { success: false, reason: `Effect index ${deviceIndex} out of range (have ${effects.length})` }
                        }

                        const effectAdapter = effects[deviceIndex]

                        // Strategy 1: Adapter Named Parameters (Standard)
                        if (('namedParameter' in effectAdapter) && this.trySetParam((effectAdapter as unknown as WithNamedParams).namedParameter, paramPath, value)) {
                            return { success: true, message: `Set ${trackName}:effect[${deviceIndex}].${paramPath} = ${value}` }
                        }

                        // Strategy 2: Box Direct Access (Bypass - for Plugins/AudioUnits)
                        if (this.trySetParam(effectAdapter.box, paramPath, value)) {
                            return { success: true, message: `Set (Deep) ${trackName}:effect[${deviceIndex}].${paramPath} = ${value}` }
                        }

                        return { success: false, reason: `Parameter '${paramPath}' not found on effect (tried Adapter & Box).` }
                    }

                    if (deviceType === "midiEffect") {
                        const effects = adapter.midiEffects.adapters()

                        if (deviceIndex < 0 || deviceIndex >= effects.length) {
                            return { success: false, reason: `MIDI effect index ${deviceIndex} out of range (have ${effects.length})` }
                        }

                        const effectAdapter = effects[deviceIndex]

                        // Hybrid Access
                        if ('namedParameter' in effectAdapter && this.trySetParam((effectAdapter as unknown as WithNamedParams).namedParameter, paramPath, value)) {
                            return { success: true, message: `Set MIDI ${trackName}:${deviceIndex}.${paramPath}` }
                        }
                        if (this.trySetParam(effectAdapter.box, paramPath, value)) {
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
                        const namedParams = (instrument as unknown as WithNamedParams).namedParameter
                        if (isDefined(namedParams) && this.trySetParam(namedParams, paramPath, value)) {
                            return { success: true, message: `Set Instrument ${trackName}.${paramPath}` }
                        }
                        // Fallback to Box (e.g. for simple synths or direct props)
                        const box = (instrument as { box: unknown }).box
                        if (isDefined(box) && this.trySetParam(box, paramPath, value)) {
                            return { success: true, message: `Set (Deep) Instrument ${trackName}.${paramPath}` }
                        }

                        return { success: false, reason: `Instrument parameter '${paramPath}' not found.` }
                    }

                    return { success: false, reason: `Unknown device type: ${deviceType}` }
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e)
                    console.error("setDeviceParam failed", e)
                    return { success: false, reason: msg }
                }
            },
            none: () => Promise.resolve({ success: false, reason: "Track not found" })
        })
    }

    async getDeviceParameters(trackName: string, deviceType: "instrument" | "effect" | "midiEffect", deviceIndex: number = 0): Promise<string[]> {
        return this.findAudioUnitAdapter(trackName).match({
            some: (adapter) => {
                if (deviceType === "instrument") {
                    const optInput = adapter.inputAdapter
                    if (optInput.isEmpty()) return []
                    const instrument = optInput.unwrap() as unknown as DeviceAdapterWithParams
                    return this.extractParameters(instrument)
                } else if (deviceType === "effect") {
                    const effects = adapter.audioEffects.adapters()
                    if (deviceIndex < 0 || deviceIndex >= effects.length) return []
                    const effect = effects[deviceIndex] as unknown as DeviceAdapterWithParams
                    return this.extractParameters(effect)
                } else if (deviceType === "midiEffect") {
                    const effects = adapter.midiEffects.adapters()
                    if (deviceIndex < 0 || deviceIndex >= effects.length) return []
                    const effect = effects[deviceIndex] as unknown as DeviceAdapterWithParams
                    return this.extractParameters(effect)
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
        const adapterMeta = this.findAudioUnitAdapter(trackName)
        if (adapterMeta.isEmpty()) return { success: false, reason: "Track not found" }
        const adapter = adapterMeta.unwrap()

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
                let modularSetup: ModularSetup | undefined
                if (effectType.toLowerCase() === 'modular') {
                    // Full Modular stack per EffectFactories.ts
                    modularSetup = ModularBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                        box.collection.refer(this.studio.project.rootBox.modularSetups)
                        box.label.setValue("Modular")
                    })
                    const modularInput = ModularAudioInputBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                        if (modularSetup) {
                            box.attributes.collection.refer(modularSetup.modules)
                        }
                        box.attributes.label.setValue("Modular Input")
                        box.attributes.x.setValue(-256)
                        box.attributes.y.setValue(32)
                    })
                    const modularOutput = ModularAudioOutputBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                        if (modularSetup) {
                            box.attributes.collection.refer(modularSetup.modules)
                        }
                        box.attributes.label.setValue("Modular Output")
                        box.attributes.x.setValue(256)
                        box.attributes.y.setValue(32)
                    })
                    ModuleConnectionBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                        if (modularSetup) {
                            box.collection.refer(modularSetup.connections)
                        }
                        box.source.refer(modularInput.output)
                        box.target.refer(modularOutput.input)
                    })
                }
                // Create and Link Effect
                BoxClass.create(this.studio.project.boxGraph, UUID.generate(), (box: any) => {
                    const hostBox = box as { host?: PointerField<any>, label: Field<string>, index?: Int32Field }
                    // Bi-directional link
                    if (hostBox.host && adapter.box.audioEffects) {
                        hostBox.host.refer(adapter.box.audioEffects)
                    }
                    if (modularSetup && 'modularSetup' in box) {
                        (box as ModularDeviceBox).modularSetup.refer(modularSetup.device)
                    }
                    if (hostBox.index) {
                        hostBox.index.setValue(adapter.audioEffects.getMinFreeIndex())
                    }
                })
            })

            this.studio.odieEvents.notify({ type: "effect-added", track: trackName, effect: effectType })

            return { success: true, message: `Added ${effectType}` }

        } catch (e: unknown) {
            return { success: false, reason: `addEffect error: ${e instanceof Error ? e.message : String(e)}` }
        }
    }

    /**
     * Add a MIDI effect to a track.
     * @param trackName - Name of the track
     * @param effectType - "arpeggio" | "velocity" | "pitch"
     */
    async addMidiEffect(trackName: string, effectType: string): Promise<ToolResult> {
        const adapterMeta = this.findAudioUnitAdapter(trackName)
        if (adapterMeta.isEmpty()) return { success: false, reason: "Track not found" }
        const adapter = adapterMeta.unwrap()

        if (adapter.isBus) {
            return { success: false, reason: "MIDI effects can only be added to regular tracks, not Aux busses." }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                    const hostBox = box as unknown as HostableDeviceBox
                    if (hostBox.host && adapter.box.midiEffects) {
                        hostBox.host.refer(adapter.box.midiEffects)

                        const index = adapter.midiEffects.getMinFreeIndex()
                        if (index === -1) {
                            throw new Error("No free MIDI effect slots available on this track.")
                        }

                        if (hostBox.index) {
                            hostBox.index.setValue(index)
                        }
                    } else {
                        console.error("MIDI Effect creation failed: missing host/field wiring")
                    }
                })
            })

            this.studio.odieEvents.notify({ type: "effect-added", track: trackName, effect: effectType })

            return { success: true, message: `Added MIDI ${effectType}` }

        } catch (e: unknown) {
            return { success: false, reason: `addMidiEffect error: ${e instanceof Error ? e.message : String(e)}` }
        }
    }

    // --- STOP HERE ---

    async addNoteClip(trackName: string, label: string, notes: MidiNoteDef[]): Promise<ToolResult> {
        const adapterMeta = this.findAudioUnitAdapter(trackName)
        if (adapterMeta.isEmpty()) return { success: false, reason: `Track '${trackName}' not found` }
        const adapter = adapterMeta.unwrap()

        const track = this.findFirstTrack(adapter)

        if (!track) return { success: false, reason: "No timeline track found on unit (Collection empty or unknown type)" }

        // Get the actual Box from the Adapter
        // track is likely TrackBoxAdapter, exposing .box
        const trackBox = track.box
        if (!trackBox) return { success: false, reason: "Track Adapter has no underlying Box" }
        if (!trackBox.regions) return { success: false, reason: "Track Box has no regions collection" }

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
                    // FIX: Relative position
                    box.position.setValue(PPQN.fromSignature(n.startTime - 1, 1) - PPQN.fromSignature(minNoteBar - 1, 1))
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

                const hostAdapter = (track as unknown as { box: { regions: unknown } })
                if (hostAdapter.box.regions) {
                    box.regions.refer(hostAdapter.box.regions as any)
                }
            })
        })

        return { success: true, message: `Created Note Clip '${label}' on '${trackName}'` }
    }

    async addNote(trackName: string, pitch: number, start: number, duration: number, velocity: number): Promise<ToolResult> {
        const adapterMeta = this.findAudioUnitAdapter(trackName)
        if (adapterMeta.isEmpty()) return { success: false, reason: `Track '${trackName}' not found` }
        const adapter = adapterMeta.unwrap()

        // 1. Convert 1-based Bars to PPQN
        // Assuming 4/4 signature for simplified logic, or use PPQN helper
        const ppqnStart = (start - 1) * 4
        const ppqnDuration = duration * 4

        // 2. Find Target Region
        // We use our helper findRegion (which expects PPQN)
        // We need to look up the specific track lane (Values()[0]) usually
        const track = this.findFirstTrack(adapter)

        if (!track) return { success: false, reason: "No track lane found." }

        const regions = track.regions.collection.asArray() as AnyRegionBoxAdapter[]
        let region = regions.find(r => {
            // Adapters expose getters for position/duration
            return r.position <= ppqnStart && (r.position + r.duration) >= ppqnStart
        }) as NoteRegionBoxAdapter | undefined

        if (!region) {
            // Auto-Create Clip (MVP: 4 bar default)

            // Ensure 1-based logic consistency with addNoteClip
            // If start is 5, quantizeBar is 4. Let's start at the exact bar requested or quantized.
            // Simplified: Start at requested bar for 4 bars.
            const clipStart = start
            const clipDur = 4

            console.log(`[Odie] Auto-creating clip at bar ${clipStart} on ${trackName}`)

            // Re-use our existing tool logic "addNoteClip" but simplified for internal use
            // Or just inline the creation safely.
            // Let's call addNoteClip if we can, but it expects specific notes. 
            // Better to just inline the region creation similar to addNoteClip but empty.

            try {
                this.studio.project.editing.modify(() => {
                    const eventCollection = NoteEventCollectionBox.create(this.studio.project.boxGraph, UUID.generate())

                    // Create Region Box
                    NoteRegionBox.create(this.studio.project.boxGraph, UUID.generate(), box => {
                        box.position.setValue(PPQN.fromSignature(clipStart - 1, 1))
                        box.duration.setValue(PPQN.fromSignature(clipDur, 1))
                        box.label.setValue("Clip")
                        // box.events.refer(eventCollection.owners)
                        box.events.refer(eventCollection.owners)

                        // Link to Track
                        const trackBox = (track as unknown as { box: Box }).box
                        if (isDefined(trackBox)) {
                            box.regions.refer(trackBox)
                        }
                    })
                })

                // Re-fetch region after creation
                const trackAdapter = track as unknown as { regions: { collection: { asArray(): unknown[] } } }
                const newRegions = trackAdapter.regions.collection.asArray() as AnyRegionBoxAdapter[]
                region = newRegions.find(r => {
                    return r.position <= ppqnStart && (r.position + r.duration) >= ppqnStart
                }) as NoteRegionBoxAdapter | undefined

                if (!region) throw new Error("Failed to find created region")

            } catch (e: unknown) {
                return { success: false, reason: `No clip found and auto-creation failed: ${e instanceof Error ? e.message : String(e)}` }
            }
        }

        if (!(region instanceof NoteRegionBoxAdapter)) {
            return { success: false, reason: "Target region is not a MIDI clip." }
        }

        // 3. Inject Note
        try {
            this.studio.project.editing.modify(() => {
                const eventCollection = region!.optCollection.unwrap()
                // Local position within the region
                const localPosition = ppqnStart - region!.position

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


        } catch (e: unknown) {
            console.error("addNote failed", e)
            return { success: false, reason: `addNote error: ${e instanceof Error ? e.message : String(e)}` }
        }
    }



    async newProject(): Promise<ToolResult> {
        try {
            await this.studio.newProject()
            return { success: true, message: "Created New Project" }
        } catch (e: unknown) {
            return { success: false, reason: `Failed to create new project: ${e instanceof Error ? e.message : String(e)}` }
        }
    }

    // --- Assets ---

    async listSamples(): Promise<{ uuid: string, name: string }[]> {
        // cast to unknown to access protected collectAllFiles if needed, or if it returns any
        const assets = await this.studio.sampleService.collectAllFiles()
        return (assets as unknown as { uuid: string, name: string }[]).map(a => ({ uuid: a.uuid, name: a.name }))
    }

    async listSoundfonts(): Promise<{ uuid: string, name: string }[]> {
        const assets = await this.studio.soundfontService.collectAllFiles()
        return (assets as unknown as { uuid: string, name: string }[]).map(a => ({ uuid: a.uuid, name: a.name }))
    }

    /** Helper to robustly find the first track lane from an adapter */
    /** Helper to robustly find the first track lane from an adapter */
    private findFirstTrack(adapter: AudioUnitBoxAdapter): TrackBoxAdapter | undefined {
        const tracks = adapter.tracks.values()
        return tracks.length > 0 ? tracks[0] : undefined
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

        const adapterMeta = this.findAudioUnitAdapter(trackName)
        if (adapterMeta.isEmpty()) return { success: false, reason: "Track not found" }
        const adapter = adapterMeta.unwrap()

        const instrument = adapter.inputAdapter.match({
            some: input => input.type === "instrument" ? input : undefined,
            none: () => undefined
        })

        if (!instrument || !(instrument instanceof NanoDeviceBoxAdapter)) {
            return { success: false, reason: `No Nano instrument found on track '${trackName}'` }
        }

        const nano = instrument as NanoDeviceBoxAdapter
        const { editing, boxGraph } = this.studio.project
        const allSamples = await this.studio.sampleService.collectAllFiles()
        const fullAsset = (allSamples as unknown as Array<{ uuid: string, duration: number }>).find((a) => a.uuid === asset.uuid)

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
                const allSamples = await this.studio.sampleService.collectAllFiles()
                const fullAsset = (allSamples as unknown as Array<{ uuid: string, duration: number }>).find((a) => a.uuid === asset.uuid)

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

    private trySetParam(targetRoot: unknown, path: string, val: number): boolean {
        if (!targetRoot) return false
        try {
            const parts = path.split('.')
            let current = targetRoot as Record<string, unknown>
            // Traverse
            for (let i = 0; i < parts.length; i++) {
                current = current[parts[i]] as Record<string, unknown>
                if (!current) return false
            }
            // Check if leaf is a Parameter (has setValue)
            if (current && typeof (current as { setValue?: unknown }).setValue === 'function') {
                this.studio.project.editing.modify(() => {
                    (current as { setValue(v: number): void }).setValue(val)
                })
                return true
            }
            return false
        } catch (e) {
            return false
        }
    }

    /**
     * Helper to extract parameters from a device adapter.
     */
    private extractParameters(device: DeviceAdapterWithParams): string[] {
        const keys: string[] = []
        if (!device || !device.namedParameter) return keys

        const walk = (node: unknown, path: string = "") => {
            if (!node) return
            const n = node as Record<string, unknown>
            // If it's a Parameter (has setValue)
            if (typeof n.setValue === "function") {
                keys.push(path)
                return
            }
            // Recurse
            for (const key of Object.keys(n)) {
                // simple loop over keys
                // Skip internal properties if needed, but namedParameter usually clean
                const child = n[key]
                const subPath = path ? `${path}.${key}` : key
                // avoid cycling or huge trees
                if (typeof child === "object" && child !== null) {
                    walk(child, subPath)
                }
            }
        }

        walk(device.namedParameter)
        return keys
    }
}
