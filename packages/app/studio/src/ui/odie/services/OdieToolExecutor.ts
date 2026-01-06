
import { StudioService } from "@/service/StudioService"
import { OdieAppControl } from "./OdieAppControl"
import { AIService } from "./AIService"
import { ToolCall } from "./llm/LLMProvider"
import { Message } from "./llm/LLMProvider"

export interface ExecutorContext {
    studio: StudioService
    appControl: OdieAppControl
    ai: AIService

    // Callbacks for OdieService state
    setGenUiPayload: (payload: any) => void
    setSidebarVisible: (visible: boolean) => void

    // State for inference
    contextState: any
    recentMessages: Message[]
}

export interface ToolResult {
    success: boolean
    userMessage?: string
    systemError?: string
    analysisData?: any
}

export class OdieToolExecutor {
    constructor() { }

    async execute(call: ToolCall, ctx: ExecutorContext): Promise<ToolResult> {
        const name = call.name
        const args = call.arguments || {}

        try {
            switch (name) {
                // --- PROJECT ---
                case "project_create":
                    await ctx.appControl.createProject()
                    return { success: true, userMessage: "✅ Created new project" }

                case "project_load":
                    const pLoaded = await ctx.appControl.loadProject()
                    return { success: pLoaded, userMessage: pLoaded ? "📂 Opened Project Browser" : undefined }

                case "project_export_mix":
                    const mExp = await ctx.appControl.exportMixdown()
                    return { success: mExp, userMessage: mExp ? "💿 Export initiated (Dialog)" : undefined }

                case "project_export_stems":
                    const sExp = await ctx.appControl.exportStems()
                    return { success: sExp, userMessage: sExp ? "💿 Export Stems initiated (Dialog)" : undefined }

                // --- TRANSPORT ---
                case "transport_play":
                    await ctx.appControl.play()
                    return { success: true, userMessage: "▶️ Playing" }

                case "transport_stop":
                    await ctx.appControl.stop()
                    return { success: true, userMessage: "⏹️ Stopped" }

                case "transport_loop":
                    await ctx.appControl.setLoop(Boolean(args.enabled))
                    return { success: true, userMessage: `🔁 Loop ${args.enabled ? "enabled" : "disabled"}` }

                case "transport_set_bpm": {
                    const bpm = parseFloat(String(args.bpm))
                    const success = await ctx.appControl.setBpm(bpm)
                    return {
                        success,
                        userMessage: success ? `🎵 BPM set to ${bpm}` : `🎵 BPM ${bpm} is out of range. Valid range: 20-999.`
                    }
                }

                case "transport_set_time_signature": {
                    const num = parseInt(String(args.numerator))
                    const denom = parseInt(String(args.denominator))
                    const success = await ctx.appControl.setTimeSignature(num, denom)
                    return {
                        success,
                        userMessage: success ? `⏱️ Sig set to ${num}/${denom}` : `❌ Failed to set time signature`
                    }
                }

                // --- RECORDING ---
                case "recording_start":
                    await ctx.appControl.record(args.countIn !== false)
                    return { success: true, userMessage: "🔴 Recording" }

                case "recording_stop":
                    await ctx.appControl.stopRecording()
                    return { success: true, userMessage: "⏹️ Recording Stopped" }


                // --- TRACKS (Arrangement & Notes) ---
                case "track_add": // Alias
                case "arrangement_add_track": {
                    const res = await ctx.appControl.addTrack(args.type || "synth", args.name || "New Track")
                    return {
                        success: res.success,
                        userMessage: res.success ? `✅ Added ${args.type || "synth"} track: "${args.name || "New Track"}"` : `❌ Failed: ${res.reason}`
                    }
                }

                case "arrangement_add_bus": {
                    const result = await ctx.appControl.addAuxTrack(args.name)
                    return {
                        success: result.success,
                        userMessage: result.success ? `✅ Added Bus: "${args.name}"` : `❌ Failed to add bus: ${result.reason}`
                    }
                }

                case "arrangement_add_midi_effect": {
                    const result = await ctx.appControl.addMidiEffect(args.trackName, args.effectType)
                    return {
                        success: result.success,
                        userMessage: result.success ? `🎹 Added MIDI Effect: ${args.effectType} on ${args.trackName}` : `❌ Failed to add MIDI effect: ${result.reason}`
                    }
                }

                case "track_delete": // Alias
                case "arrangement_delete_track":
                    const delSuccess = await ctx.appControl.deleteTrack(args.name)
                    return {
                        success: delSuccess,
                        userMessage: delSuccess ? `🗑️ Deleted track: "${args.name}"` : `❌ Failed to delete track: ${args.name}`
                    }

                case "track_list": // Alias
                case "arrangement_list_tracks": {
                    const tracks = await ctx.appControl.listTracks()
                    if (tracks.length === 0) return { success: true, userMessage: "📋 No tracks found." }
                    const list = tracks.map(t => `- 🎹 **${t}**`).join("\n")
                    return { success: true, userMessage: `📋 **Project Tracks:**\n${list}` }
                }

                case "notes_add": {
                    const track = args.trackName as string
                    const notes = args.notes as { pitch: number, startTime: number, duration: number, velocity: number }[]
                    const result = await ctx.appControl.addMidiNotes(track, notes)
                    return {
                        success: result.success,
                        userMessage: result.success ? `✅ Added ${notes.length} MIDI notes to "${track}"` : `❌ Failed to add notes to "${track}": ${result.reason}`
                    }
                }

                // --- MIXER ---
                case "mixer_volume": {
                    const result = await ctx.appControl.setVolume(args.trackName, parseFloat(String(args.db)))
                    return {
                        success: result.success,
                        userMessage: result.success ? `🔊 ${args.trackName} → ${args.db}dB` : `🔊 Volume failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "mixer_pan": {
                    const result = await ctx.appControl.setPan(args.trackName, parseFloat(String(args.pan)))
                    return {
                        success: result.success,
                        userMessage: result.success ? `↔️ ${args.trackName} pan → ${args.pan}` : `↔️ Pan failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "mixer_mute": {
                    const result = await ctx.appControl.mute(args.trackName, Boolean(args.muted))
                    return {
                        success: result.success,
                        userMessage: result.success ? `${args.muted ? "🔇" : "🔊"} ${args.trackName} ${args.muted ? "muted" : "unmuted"}` : `🔇 Mute failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "mixer_solo": {
                    const result = await ctx.appControl.solo(args.trackName, Boolean(args.soloed))
                    return {
                        success: result.success,
                        userMessage: result.success ? `${args.soloed ? "🎤" : "👥"} ${args.trackName} ${args.soloed ? "soloed" : "unsoloed"}` : `🎤 Solo failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "mixer_add_send": {
                    const result = await ctx.appControl.addSend(args.trackName, args.auxName, args.db)
                    return {
                        success: result.success,
                        userMessage: result.success ? `🔊 Sent ${args.trackName} to ${args.auxName} @ ${args.db || -6}dB` : `❌ Failed to add send: ${result.reason}`
                    }
                }
                case "mixer_add_effect": {
                    const result = await ctx.appControl.addEffect(args.trackName, args.effectType)
                    return {
                        success: result.success,
                        userMessage: result.success ? `✨ Added ${args.effectType} to ${args.trackName}` : `❌ Failed to add effect: ${result.reason}`
                    }
                }
                case "mixer_set_routing": {
                    const result = await ctx.appControl.setRouting(args.sourceName, args.targetBusName)
                    return {
                        success: result.success,
                        userMessage: result.success ? `🔀 Routed ${args.sourceName} → ${args.targetBusName}` : `❌ Failed to set routing: ${result.reason}`
                    }
                }


                // --- EDITING ---
                case "region_split": {
                    const result = await ctx.appControl.splitRegion(args.trackName, parseFloat(String(args.time || 0)))
                    return {
                        success: result.success,
                        userMessage: result.success ? "✂️ Region split" : `✂️ Split failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "region_move": {
                    const result = await ctx.appControl.moveRegion(args.trackName, parseFloat(String(args.time)), parseFloat(String(args.newTime)))
                    return {
                        success: result.success,
                        userMessage: result.success ? "↔️ Region moved" : `↔️ Move failed: ${result.reason || "Unknown error"}`
                    }
                }
                case "region_copy": {
                    const result = await ctx.appControl.copyRegion(args.trackName, parseFloat(String(args.time)), parseFloat(String(args.newTime)))
                    return {
                        success: result.success,
                        userMessage: result.success ? "👯 Region copied" : `👯 Copy failed: ${result.reason || "Unknown error"}`
                    }
                }


                // --- VIEW ---
                case "view_switch":
                    const vSwitch = await ctx.appControl.switchScreen(args.screen as any)
                    return { success: vSwitch, userMessage: vSwitch ? `👁️ Switched to ${args.screen} view` : undefined }
                case "view_toggle_keyboard":
                    await ctx.appControl.toggleKeyboard()
                    return { success: true, userMessage: "🎹 Toggled on-screen keyboard" }


                // --- GENERATIVE UI ---
                case "render_interface":
                    ctx.setGenUiPayload(args)
                    ctx.setSidebarVisible(true)
                    return { success: true, userMessage: "✨ Generated Interface: " + args.title }


                // --- ANALYSIS & SIGNAL CHAIN ---
                case "inspect_selection": {
                    const analysis = ctx.appControl.inspectSelection()
                    // Try parsing JSON for user friendly summary
                    let summary = "🧐 Selection analyzed."
                    try {
                        const data = JSON.parse(analysis)
                        const items = Array.isArray(data) ? data : [data]
                        const trackCount = items.filter((i: any) => i.type === "track").length
                        const regionCount = items.filter((i: any) => i.type === "region").length
                        const deviceCount = items.filter((i: any) => i.type === "device" || i.type === "unknown").length

                        if (items.length === 0) {
                            summary = "🧐 Nothing selected right now."
                        } else {
                            const parts: string[] = []
                            if (trackCount > 0) parts.push(`${trackCount} track${trackCount > 1 ? 's' : ''}`)
                            if (regionCount > 0) parts.push(`${regionCount} region${regionCount > 1 ? 's' : ''}`)
                            if (deviceCount > 0) parts.push(`${deviceCount} item${deviceCount > 1 ? 's' : ''}`)
                            summary = "🧐 Selection: " + parts.join(", ")
                        }
                    } catch { /* ignore */ }

                    return { success: true, userMessage: summary }
                }

                case "analyze_track": {
                    let trackName = args.trackName
                    if (!trackName) {
                        trackName = ctx.contextState.focus?.selectedTrackName
                        if (!trackName) throw new Error("Missing 'trackName' argument (and no track selected)")
                    }
                    // Fire and forget analysis
                    void ctx.appControl.analyzeTrack(trackName)
                    return { success: true, userMessage: `🧐 Analyzed ${trackName}. Check details in my response.` }
                }

                case "get_track_details": {
                    let trackName = args.trackName as string | undefined
                    if (!trackName) {
                        // Smart Inference logic
                        const trackList = await ctx.appControl.listTracks()
                        // 1. Check selected
                        const selected = ctx.contextState.focus?.selectedTrackName
                        if (selected && trackList.includes(selected)) {
                            trackName = selected
                        }
                        // 2. Check recent history (simplistic check)
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

                    const details = ctx.appControl.getTrackDetails(trackName)
                    return {
                        success: true,
                        userMessage: `🔍 Analyzing signal chain for "${trackName}"...`,
                        analysisData: details // Return full JSON for AI
                    }
                }

                case "get_project_overview": {
                    const overview = ctx.appControl.getProjectOverview()
                    return {
                        success: true,
                        userMessage: `📊 Analyzing project...`,
                        analysisData: overview
                    }
                }

                case "set_device_param": {
                    const { trackName, deviceType, deviceIndex, paramPath, value } = args
                    if (!trackName || !deviceType || !paramPath || value === undefined) {
                        throw new Error("Missing required arguments for set_device_param")
                    }
                    const result = await ctx.appControl.setDeviceParam(
                        trackName, deviceType, deviceIndex ?? 0, paramPath, value
                    )
                    if (result.success) {
                        return { success: true, userMessage: `🎛️ ${result.reason}` }
                    } else {
                        throw new Error(result.reason)
                    }
                }

                case "verify_action": {
                    const result = await ctx.appControl.verifyAction(args.action, args.expectedChange)
                    return {
                        success: true,
                        userMessage: `🔬 Verifying action: ${args.action}...`,
                        analysisData: result
                    }
                }


                default:
                    console.warn(`Unknown Tool: ${name}`)
                    // Return failure but not throw
                    return { success: false, systemError: `Unknown Tool: ${name}` }
            }
        } catch (e: any) {
            console.error(`Tool Execution Failed [${name}]`, e)
            return {
                success: false,
                systemError: `❌ Error: ${name} - ${e.message}`,
                // We could also return a userMessage for the dialog if we want
            }
        }
    }
}
