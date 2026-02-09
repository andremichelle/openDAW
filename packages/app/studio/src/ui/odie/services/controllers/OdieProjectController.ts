
import { Color, UUID } from "@opendaw/lib-std"
import {
    InstrumentFactory,
    InstrumentFactories,
    AudioBusFactory
} from "@opendaw/studio-adapters"
import {
    AuxSendBox
} from "@opendaw/studio-boxes"
import { AudioUnitType, IconSymbol } from "@opendaw/studio-enums"
import { OdieBaseController } from "./OdieBaseController"
import { ToolResult } from "../../OdieTypes"

interface NamedInstrumentFactory extends InstrumentFactory {
    defaultName: string
}

export class OdieProjectController extends OdieBaseController {

    // listTracks, addTrack, etc. are kept here as they belong to project management
    getProjectOverview(): string {
        const tracks = this.listTracks()
        return `Project has ${tracks.length} tracks: ${tracks.join(", ")} `
    }

    listTracks(): string[] {
        if (!this.studio.hasProfile) return []
        return this.studio.project.rootBoxAdapter.audioUnits.adapters()
            .filter(a => a.box.isAttached())
            .map(a => a.input.label.unwrapOrElse("Untitled"))
    }

    async addTrack(type: string, name: string = "New Track"): Promise<ToolResult> {
        if (!this.studio.hasProfile) {
            return { success: false, reason: "No active project loaded." }
        }

        const t = (type || "synth").toLowerCase()
        let factory: InstrumentFactory | undefined

        if (t === 'synth' || t === 'bass' || t === 'sub-bass') factory = InstrumentFactories.Nano
        else if (t === 'drums' || t === 'pads' || t === 'sample pads' || t === 'percussion') factory = InstrumentFactories.Playfield
        else if (t === 'keys' || t === 'piano' || t === 'orchestral' || t === 'strings') factory = InstrumentFactories.Soundfont
        else if (t === 'vaporisateur' || t === 'granular' || t === 'ambient') factory = InstrumentFactories.Vaporisateur
        else if (t === 'nano') factory = InstrumentFactories.Nano
        else if (t === 'tape' || t === 'lo-fi') factory = InstrumentFactories.Tape
        else if (t === 'midiout' || t === 'midi-output') factory = InstrumentFactories.MIDIOutput
        else if (t === "instrument") { type = "nano"; factory = InstrumentFactories.Nano; }
        else if (t !== 'audio') {
            const factories = Object.values(InstrumentFactories.Named)
            const match = factories.find(f => {
                return "defaultName" in f && (f as NamedInstrumentFactory).defaultName.toLowerCase() === t
            })

            if (match) {
                factory = match as InstrumentFactory
            } else {
                return { success: false, reason: `Unknown track type: '${type}'.Try: synth, drums, keys, lo - fi, granular, or audio.` }
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
            this.studio.project.editing.modify(() => {
                AudioBusFactory.create(
                    this.studio.project.skeleton,
                    name,
                    IconSymbol.AudioBus,
                    AudioUnitType.Bus,
                    new Color(74, 144, 226)
                )
            })

            this.studio.odieEvents.notify({ type: "track-added", name, kind: "aux" })
            return { success: true, message: `Added Aux Track "${name}"` }
        } catch (e: unknown) {
            console.error("[Odie] addAuxTrack Exception:", e)
            return { success: false, reason: `addAuxTrack Exception: ${e instanceof Error ? e.message : String(e)} ` }
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
                    return { success: false, reason: `Aux Bus "${auxName}" not found` }
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
                    return { success: false, reason: `addSend failed: ${e instanceof Error ? e.message : String(e)} ` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Source Track "${trackName}" not found` })
        })
    }

    async setTrackRouting(sourceName: string, targetBusName: string): Promise<ToolResult> {
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
                    return { success: true, message: `Routed ${sourceName} to ${targetBusName} ` }
                } catch (e: unknown) {
                    return { success: false, reason: `setTrackRouting failed: ${e instanceof Error ? e.message : String(e)} ` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Source "${sourceName}" not found` })
        })
    }

    async deleteTrack(name: string): Promise<ToolResult> {
        return this.findAudioUnitAdapter(name).match<Promise<ToolResult>>({
            some: async (box) => {
                try {
                    this.studio.project.editing.modify(() => {
                        box.box.delete()
                    })
                    this.studio.odieEvents.notify({ type: "track-deleted", name })
                    return { success: true, message: `Deleted track: "${name}"` }
                } catch (e: unknown) {
                    return { success: false, reason: `Failed to delete track: ${e instanceof Error ? e.message : String(e)} ` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${name}" not found` })
        })
    }

    async resetProject(): Promise<ToolResult> {
        try {
            this.studio.newProject()
            return { success: true, message: "Project reset successfully." }
        } catch (e: unknown) {
            console.error("resetProject failed", e)
            return { success: false, reason: e instanceof Error ? e.message : String(e) }
        }
    }

    async loadTemplate(name: string): Promise<boolean> {
        try {
            await this.studio.loadTemplate(name)
            return true
        } catch (e) {
            console.error("loadTemplate failed", e)
            return false
        }
    }

    async loadProject(name?: string): Promise<boolean> {
        try {
            if (name) {
                await this.studio.loadTemplate(name)
            } else {
                await this.studio.browseLocalProjects()
            }
            return true
        } catch (e) {
            console.error("loadProject failed", e)
            return false
        }
    }

    async saveProject(): Promise<ToolResult> {
        try {
            await this.studio.projectProfileService.save()
            return { success: true, message: "Project saved successfully." }
        } catch (e: unknown) {
            return { success: false, reason: `Save failed: ${e instanceof Error ? e.message : String(e)} ` }
        }
    }
}
