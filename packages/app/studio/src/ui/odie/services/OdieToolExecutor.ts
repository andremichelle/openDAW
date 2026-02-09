import { StudioService } from "../../../service/StudioService"
import { OdieAppControl } from "./OdieAppControl"
import { MidiNoteDef, ToolResult } from "../OdieTypes"
import { JsonValue, Message, ToolCall } from "./llm/LLMProvider"
import { AIService } from "./AIService"

// Helper functions to safely extract typed values from JsonValue args
const asString = (val: JsonValue | undefined): string => typeof val === "string" ? val : String(val ?? "")
const asOptionalString = (val: JsonValue | undefined): string | undefined => typeof val === "string" ? val : undefined
const asNumber = (val: JsonValue | undefined): number => typeof val === "number" ? val : parseFloat(String(val ?? 0)) || 0
const asBoolean = (val: JsonValue | undefined): boolean => typeof val === "boolean" ? val : val === "true"

export interface ExecutorContext {
    studio: StudioService
    appControl: OdieAppControl
    ai: AIService

    // Callbacks for OdieService state
    setGenUiPayload: (payload: JsonValue) => void
    setSidebarVisible: (visible: boolean) => void

    // State for inference
    contextState: Record<string, JsonValue>
    recentMessages: Message[]
}

export class OdieToolExecutor {
    constructor() { }

    async executeToolCalls(calls: ToolCall[], ctx: ExecutorContext): Promise<ToolResult[]> {
        const results: ToolResult[] = []
        for (const call of calls) {
            results.push(await this.execute(call, ctx))
        }
        return results
    }

    async execute(call: ToolCall, ctx: ExecutorContext): Promise<ToolResult> {
        const name = call.name
        const args = call.arguments || {}

        try {
            switch (name) {
                // Project
                case "project_create":
                    await ctx.appControl.createProject()
                    return { success: true, userMessage: "Created new project" }

                case "project_load": {
                    const pLoaded = await ctx.appControl.loadProject()
                    return { success: pLoaded, userMessage: pLoaded ? "Opened Project Browser" : undefined }
                }

                case "project_export_mix": {
                    const mExp = await ctx.appControl.exportMixdown()
                    return { success: mExp, userMessage: mExp ? "Export initiated" : undefined }
                }

                case "project_export_stems": {
                    const sExp = await ctx.appControl.exportStems()
                    return { success: sExp, userMessage: sExp ? "Export Stems initiated" : undefined }
                }

                // Transport
                case "transport_play":
                    await ctx.appControl.play()
                    return { success: true, userMessage: "Playing" }

                case "transport_stop":
                    await ctx.appControl.stop()
                    return { success: true, userMessage: "Stopped" }

                case "transport_loop":
                    await ctx.appControl.setLoop(Boolean(args.enabled))
                    return { success: true, userMessage: `Loop ${args.enabled ? "enabled" : "disabled"}` }

                case "transport_set_bpm": {
                    const bpm = parseFloat(String(args.bpm))
                    const result = await ctx.appControl.setBpm(bpm)
                    return {
                        success: result.success,
                        userMessage: result.success ? `BPM set to ${bpm}` : result.reason
                    }
                }

                case "transport_set_time_signature": {
                    const num = parseInt(String(args.numerator))
                    const denom = parseInt(String(args.denominator))
                    const result = await ctx.appControl.setTimeSignature(num, denom)
                    return {
                        success: result.success,
                        userMessage: result.success ? `Time Signature set to ${num}/${denom}` : result.reason
                    }
                }

                // Recording
                case "recording_start":
                    await ctx.appControl.record(args.countIn !== false)
                    return { success: true, userMessage: "Recording" }

                case "recording_stop":
                    await ctx.appControl.stopRecording()
                    return { success: true, userMessage: "Recording Stopped" }

                case "transport_set_count_in": {
                    const bars = parseInt(String(args.bars))
                    await ctx.appControl.setCountIn(bars)
                    return { success: true, userMessage: `Count-in set to ${bars} bars` }
                }


                // Tracks
                case "track_add":
                case "arrangement_add_track": {
                    const trackType = asString(args.type) || "synth"
                    const trackName = asString(args.name) || "New Track"
                    const res = await ctx.appControl.addTrack(trackType, trackName)
                    return {
                        success: res.success,
                        userMessage: res.success ? `Added ${trackType} track: "${trackName}"` : `Failed: ${res.reason}`
                    }
                }

                case "arrangement_add_bus": {
                    const busName = asString(args.name)
                    const result = await ctx.appControl.addAuxTrack(busName)
                    return {
                        success: result.success,
                        userMessage: result.success ? `Added Bus: "${busName}"` : `Failed to add bus: ${result.reason}`
                    }
                }

                case "arrangement_add_midi_effect": {
                    const trackName = asString(args.trackName)
                    const effectType = asString(args.effectType)
                    const result = await ctx.appControl.addMidiEffect(trackName, effectType)
                    return {
                        success: result.success,
                        userMessage: result.success ? `Added MIDI Effect: ${effectType} on ${trackName}` : `Failed to add MIDI effect: ${result.reason}`
                    }
                }

                case "track_delete":
                case "arrangement_delete_track": {
                    const trackName = asString(args.name)
                    const delResult = await ctx.appControl.deleteTrack(trackName)
                    return {
                        success: delResult.success,
                        userMessage: delResult.success ? `Deleted track: "${trackName}"` : `Failed to delete track: ${delResult.reason}`
                    }
                }

                case "track_list":
                case "arrangement_list_tracks": {
                    const tracks = await ctx.appControl.listTracks()
                    if (tracks.length === 0) return { success: true, userMessage: "No tracks found." }
                    const list = tracks.map(t => `- **${t}**`).join("\n")
                    return { success: true, userMessage: `**Project Tracks:**\n${list}` }
                }

                case "notes_add": {
                    const track = asString(args.trackName)
                    const notes = Array.isArray(args.notes) ? args.notes : []
                    const mappedNotes = notes.map(n => {
                        const obj = n as Record<string, JsonValue>
                        return {
                            startTime: asNumber(obj.startTime),
                            duration: asNumber(obj.duration),
                            pitch: asNumber(obj.pitch),
                            velocity: asNumber(obj.velocity)
                        } as MidiNoteDef
                    })
                    const result = await ctx.appControl.addMidiNotes(track, mappedNotes)
                    return {
                        success: result.success,
                        userMessage: result.success ? `Added ${notes.length} MIDI notes to "${track}"` : `Failed to add notes to "${track}": ${result.reason}`
                    }
                }

                case "notes_get":
                case "arrangement_get_notes": {
                    const trackName = asString(args.trackName)
                    const result = await ctx.appControl.getMidiNotes(trackName)
                    if (!result.notes || result.notes.length === 0) return { success: true, userMessage: `No notes found on "${trackName}"` }
                    return {
                        success: true,
                        userMessage: `Found ${result.notes.length} notes on "${trackName}"`,
                        analysisData: JSON.stringify(result.notes)
                    }
                }

                // Mixer
                case "mixer_volume": {
                    const trackName = asString(args.trackName)
                    const db = asNumber(args.db)
                    const result = await ctx.appControl.setVolume(trackName, db)
                    return {
                        success: result.success,
                        userMessage: result.success ? `${trackName} → ${db}dB` : `Volume failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "mixer_pan": {
                    const trackName = asString(args.trackName)
                    const pan = asNumber(args.pan)
                    const result = await ctx.appControl.setPan(trackName, pan)
                    return {
                        success: result.success,
                        userMessage: result.success ? `${trackName} pan → ${pan}` : `Pan failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "mixer_mute": {
                    const trackName = asString(args.trackName)
                    const muted = asBoolean(args.muted)
                    const result = await ctx.appControl.mute(trackName, muted)
                    return {
                        success: result.success,
                        userMessage: result.success ? `${trackName} ${muted ? "muted" : "unmuted"}` : `Mute failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "mixer_solo": {
                    const trackName = asString(args.trackName)
                    const soloed = asBoolean(args.soloed)
                    const result = await ctx.appControl.solo(trackName, soloed)
                    return {
                        success: result.success,
                        userMessage: result.success ? `${trackName} ${soloed ? "soloed" : "unsoloed"}` : `Solo failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "mixer_add_send": {
                    const trackName = asString(args.trackName)
                    const auxName = asString(args.auxName)
                    const db = asNumber(args.db) || -6
                    const result = await ctx.appControl.addSend(trackName, auxName, db)
                    return {
                        success: result.success,
                        userMessage: result.success ? `Sent ${trackName} to ${auxName} @ ${db}dB` : `Failed to add send: ${result.reason}`
                    }
                }
                case "mixer_add_effect": {
                    const trackName = asString(args.trackName)
                    const effectType = asString(args.effectType)
                    const result = await ctx.appControl.addEffect(trackName, effectType)
                    return {
                        success: result.success,
                        userMessage: result.success ? `Added ${effectType} to ${trackName}` : `Failed to add effect: ${result.reason}`
                    }
                }
                case "mixer_set_routing": {
                    const sourceName = asString(args.sourceName)
                    const targetBusName = asString(args.targetBusName)
                    const result = await ctx.appControl.setRouting(sourceName, targetBusName)
                    return {
                        success: result.success,
                        userMessage: result.success ? `Routed ${sourceName} → ${targetBusName}` : `Failed to set routing: ${result.reason}`
                    }
                }


                // Editing
                case "region_split": {
                    const result = await ctx.appControl.splitRegion(asString(args.trackName), asNumber(args.time))
                    return {
                        success: result.success,
                        userMessage: result.success ? "Region split" : `Split failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "region_move": {
                    const result = await ctx.appControl.moveRegion(asString(args.trackName), asNumber(args.time), asNumber(args.newTime))
                    return {
                        success: result.success,
                        userMessage: result.success ? "Region moved" : `Move failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "region_copy": {
                    const result = await ctx.appControl.copyRegion(asString(args.trackName), asNumber(args.time), asNumber(args.newTime))
                    return {
                        success: result.success,
                        userMessage: result.success ? "Region copied" : `Copy failed: ${result.reason || "Unknown error"}`
                    }
                }


                // View
                case "view_switch": {
                    const screen = args.screen === "scene" ? "scene" : "arrangement"
                    const vSwitch = await ctx.appControl.switchScreen(screen)
                    return { success: vSwitch, userMessage: vSwitch ? `Switched to ${screen} view` : undefined }
                }
                case "view_toggle_keyboard":
                    await ctx.appControl.toggleKeyboard()
                    return { success: true, userMessage: "Toggled keyboard" }


                // Generative UI
                case "render_interface":
                    ctx.setGenUiPayload(args)
                    ctx.setSidebarVisible(true)
                    return { success: true, userMessage: "Generated Interface: " + asString(args.title) }


                // Analysis
                case "inspect_selection": {
                    const analysis = await ctx.appControl.inspectSelection()
                    let summary = analysis.message || "Selection analyzed."
                    return { success: true, userMessage: summary }
                }

                case "analyze_track": {
                    let trackName = asOptionalString(args.trackName)
                    if (!trackName) {
                        const focus = ctx.contextState.focus as { [key: string]: JsonValue } | undefined
                        trackName = focus?.selectedTrackName as string | undefined
                        if (!trackName) throw new Error("Missing 'trackName' argument")
                    }
                    await ctx.appControl.analyzeTrack(trackName)
                    return { success: true, userMessage: `Analyzed ${trackName}.` }
                }

                case "get_track_details": {
                    let trackName = args.trackName as string | undefined
                    if (!trackName) {
                        const trackList = await ctx.appControl.listTracks()
                        const focus = ctx.contextState.focus as { [key: string]: JsonValue } | undefined
                        const selected = focus?.selectedTrackName as string | undefined
                        if (selected && trackList.includes(selected)) {
                            trackName = selected
                        }
                        if (!trackName) {
                            for (const msg of (ctx.recentMessages || []).slice().reverse().slice(0, 6)) {
                                if (!msg.content) continue
                                const found = trackList.find(t => msg.content.toLowerCase().includes(t.toLowerCase()))
                                if (found) {
                                    trackName = found
                                    break
                                }
                            }
                        }
                        if (!trackName) {
                            throw new Error(`No track specified. Available tracks: ${trackList.join(", ")}`)
                        }
                    }

                    const toolResult = await ctx.appControl.getTrackDetails(trackName)
                    return {
                        success: toolResult.success,
                        userMessage: toolResult.success ? `Analyzing "${trackName}" details...` : `Failed to get track details: ${toolResult.reason}`,
                        analysisData: toolResult.success ? JSON.stringify(toolResult.data) : undefined
                    }
                }

                case "get_project_overview": {
                    const overview = ctx.appControl.getProjectOverview()
                    return {
                        success: true,
                        userMessage: `Analyzing project...`,
                        analysisData: overview
                    }
                }
                case "set_device_param": {
                    const trackName = asOptionalString(args.trackName)
                    const deviceType = asOptionalString(args.deviceType)
                    const deviceIndex = asNumber(args.deviceIndex)
                    const paramPath = asOptionalString(args.paramPath)
                    const rawValue = args.value
                    if (!trackName || !deviceType || !paramPath || rawValue === undefined) {
                        throw new Error("Missing required arguments for set_device_param")
                    }
                    const numericValue = typeof rawValue === "number" ? rawValue : Number(rawValue)
                    if (isNaN(numericValue)) {
                        throw new Error(`Invalid value for set_device_param: ${rawValue}`)
                    }
                    const result = await ctx.appControl.setDeviceParam(
                        trackName, deviceType as "mixer" | "instrument" | "effect" | "midiEffect", deviceIndex, paramPath, numericValue
                    )
                    if (result.success) {
                        return { success: true, userMessage: result.reason }
                    } else {
                        throw new Error(result.reason)
                    }
                }

                case "verify_action": {
                    const action = asString(args.action)
                    const expectedChange = asString(args.expectedChange)
                    const result = await ctx.appControl.verifyAction(action, expectedChange)
                    return {
                        success: true,
                        userMessage: `Verifying: ${action}`,
                        analysisData: result
                    }
                }


                default:
                    console.warn(`Unknown Tool: ${name}`)
                    return { success: false, systemError: `Unknown Tool: ${name}` }
            }
        } catch (e: unknown) {
            console.error(`Tool Execution Failed [${name}]`, e)
            return {
                success: false,
                systemError: `Error: ${name} - ${e instanceof Error ? e.message : String(e)}`,
            }
        }
    }
}
