import { DefaultObservableValue } from "@opendaw/lib-std"
import type { StudioService } from "../../service/StudioService"
import { AIService } from "./services/AIService"


import { Message } from "./services/llm/LLMProvider"
import { OdieAppControl } from "./services/OdieAppControl"
import { odiePersona } from "./services/OdiePersonaService"
import { schoolStore } from "./services/SchoolStore"
import { chatHistory } from "./services/ChatHistoryService"
import { OdieTools } from "./services/OdieToolDefinitions"
import { commandRegistry } from "./services/OdieCommandRegistry"
import { Dialogs } from "@/ui/components/dialogs"
import { OdieToolExecutor, ExecutorContext } from "./services/OdieToolExecutor"


export class OdieService {
    // State
    readonly messages = new DefaultObservableValue<Message[]>([])
    readonly open = new DefaultObservableValue<boolean>(false)
    readonly width = new DefaultObservableValue<number>(450)
    readonly visible = new DefaultObservableValue<boolean>(false) // Helper for 'open' + 'width > 0'

    // [ANTIGRAVITY] Activity State for UI
    readonly isGenerating = new DefaultObservableValue<boolean>(false)
    readonly activeModelName = new DefaultObservableValue<string>("Gemini")
    readonly activityStatus = new DefaultObservableValue<string>("Ready")

    // [ANTIGRAVITY] The Loom (Generative UI) State
    // Holds the current "Hologram" payload to be rendered
    readonly genUiPayload = new DefaultObservableValue<import("./genui/GenUISchema").GenUIPayload | null>(null)

    // [ANTIGRAVITY] Diagnostic Port (Glass Box)
    // Allows external rigs to see exactly what context the brain received
    readonly lastDebugInfo = new DefaultObservableValue<{
        systemPrompt: string
        projectContext: any
        userQuery: string
        timestamp: number
    } | null>(null)



    // View State: "wizard" | "chat" | "settings"
    readonly viewState = new DefaultObservableValue<"wizard" | "chat" | "settings">("wizard")

    // UI Toggles
    readonly showHistory = new DefaultObservableValue<boolean>(false)

    readonly ai = new AIService()
    private toolExecutor = new OdieToolExecutor()



    // The Nervous System
    // We lazily import the AppControl to avoid circular dependencies with Studio/InstrumentFactories
    public appControl?: OdieAppControl

    public studio?: StudioService

    constructor() {
        // [ANTIGRAVITY] Expose for Debugging/Extraction
        ; (window as any).odie = this;

        try {
            // Initialize View State
            if (this.ai.wizardCompleted.getValue()) {
                this.viewState.setValue("chat")
            }

            // Auto-Open if wizard not done
            if (!this.ai.wizardCompleted.getValue()) {
                // this.toggle() // Maybe too aggressive? Let user click.
            }

            // Auto-Save History
            this.messages.subscribe(() => {
                this.saveCurrentSession()
            })

            // [ANTIGRAVITY] Model Indicator Sync
            // React to provider changes to update the UI badge
            this.ai.activeProviderId.subscribe(observer => {
                const id = observer.getValue()
                let label = "Unknown"
                if (!id || typeof id !== "string") {
                    label = "AI"
                } else if (id === "gemini") label = "Gemini"
                else if (id === "gemini-3") label = "Gemini 3"
                else if (id === "ollama") {
                    // For Ollama, try to show the actual model name, or "Local"
                    const config = this.ai.getConfig("ollama")
                    label = config.modelId || "Local"
                }
                else label = id.charAt(0).toUpperCase() + id.slice(1)

                this.activeModelName.setValue(label)
            })
            // Initial Sync
            const currentId = this.ai.activeProviderId.getValue()
            if (currentId === "ollama") {
                const config = this.ai.getConfig("ollama")
                this.activeModelName.setValue(config.modelId || "Local")
            } else if (currentId === "gemini-3") {
                this.activeModelName.setValue("Gemini 3")
            }



        } catch (e) {
            console.error("🔥 OdieService Constructor CRASH:", e)
        }
    }




    toggle() {
        this.visible.setValue(!this.visible.getValue())
    }

    setWidth(width: number) {
        this.width.setValue(Math.max(300, Math.min(width, 1000)))
    }

    async connectStudio(studio: StudioService) {
        this.studio = studio
        this.ai.setStudio(studio)
        // 🔌 Wire the Nervous System
        console.log("🔌 Odie: Connecting to Studio (Dynamic)...")
        try {
            console.log("🔍 Debug: Checking OdieAppControl symbol:", OdieAppControl);
            if (!OdieAppControl) {
                console.error("❌ CRTICAL: OdieAppControl import is undefined!");
                throw new Error("OdieAppControl is undefined (Circular Dependency?)");
            }
            this.appControl = new OdieAppControl(studio)
            console.log("✅ OdieAppControl Instantiated Successfully:", this.appControl);
        } catch (e) {
            console.error("❌ Failed to load OdieAppControl:", e);
            (window as any).__ODIE_LOAD_ERROR__ = e;
        }
    }

    async sendMessage(text: string) {
        // --- 1. Command Interception (Slash Commands) ---
        if (text.startsWith("/")) {
            const [cmd, ...args] = text.trim().split(" ")
            if (commandRegistry.has(cmd)) {

                // Add User Msg IMMEDIATELY
                const userMsg: Message = { id: Date.now().toString(), role: "user", content: text, timestamp: Date.now() }
                const currentStart = this.messages.getValue()
                this.messages.setValue([...currentStart, userMsg])

                // Execute
                const result = await commandRegistry.execute(cmd, args, this)

                if (result) {
                    // Add System Msg (Feedback)
                    const sysMsg: Message = { id: (Date.now() + 1).toString(), role: "model", content: result, timestamp: Date.now() }
                    const currentPostExec = this.messages.getValue()
                    this.messages.setValue([...currentPostExec, sysMsg])
                }
                return
            }
        }

        // --- 1.5 Fast Path (Natural Language Interceptor) ---
        // [ANTIGRAVITY] Optimization: Zero-Latency routing for common commands
        // This makes "play" work as fast as "/play"
        const fastPathMap: Array<[RegExp, string, (match: RegExpMatchArray) => string[]]> = [
            [/^play$/i, "/play", () => []],
            [/^start$/i, "/play", () => []],
            [/^stop$/i, "/stop", () => []],
            [/^pause$/i, "/stop", () => []],
            [/^record$/i, "/record", () => []],
            [/^list$/i, "/list", () => []],
            [/^list tracks$/i, "/list", () => []],
            [/^add (.*) track$/i, "/add", (m) => [m[1]]], // "add synth track" -> /add synth
            [/^add (.*)$/i, "/add", (m) => [m[1]]], // "add synth" -> /add synth
            [/^new project$/i, "/new", () => []],
            [/^clear$/i, "/new", () => []],
        ]

        for (const [regex, cmd, getArgs] of fastPathMap) {
            const match = text.trim().match(regex)
            if (match) {
                console.log(`⚡ [Odie FastPath] Intercepted "${text}" -> ${cmd}`)
                const services = commandRegistry
                if (services.has(cmd)) {
                    // UI Feedback: Show user message
                    const userMsg: Message = { id: Date.now().toString(), role: "user", content: text, timestamp: Date.now() }
                    const currentStart = this.messages.getValue()
                    this.messages.setValue([...currentStart, userMsg])

                    // Execute
                    const args = getArgs(match)
                    const result = await commandRegistry.execute(cmd, args, this)

                    if (result) {
                        const sysMsg: Message = { id: (Date.now() + 1).toString(), role: "model", content: result, timestamp: Date.now() }
                        const currentPostExec = this.messages.getValue()
                        this.messages.setValue([...currentPostExec, sysMsg])
                    }
                    return
                }
            }
        }

        // --- 2. Normal AI Flow ---
        const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text, timestamp: Date.now() }
        const startMsgs = this.messages.getValue()
        this.messages.setValue([...startMsgs, userMsg])

        // Placeholder for streaming response
        const assistantMsg: Message = { id: crypto.randomUUID(), role: "model", content: "", timestamp: Date.now() }
        this.messages.setValue([...startMsgs, userMsg, assistantMsg])



        try {
            // Fix: Pass full history, not just text
            // --- Cortex Injection: Dynamic Personal & Memory ---
            const provider = this.ai.getActiveProvider()
            const config = provider ? this.ai.getConfig(provider.id) : {}

            // [ANTIGRAVITY] Smart Track Focus - Help AI understand context
            const focusState = this.ai.contextService.state.getValue().focus
            const trackList = this.safeListTracks()

            // Get currently selected track (if valid)
            const selectedTrack = focusState.selectedTrackName && trackList.includes(focusState.selectedTrackName)
                ? focusState.selectedTrackName
                : null

            // Find recently discussed track from conversation history
            const recentMessages = this.messages.getValue().slice(-6) // Last 6 messages
            let recentlyDiscussedTrack: string | null = null
            for (const msg of recentMessages.reverse()) {
                if (!msg.content) continue
                const msgLower = msg.content.toLowerCase()
                const foundTrack = trackList.find(t => msgLower.includes(t.toLowerCase()))
                if (foundTrack) {
                    recentlyDiscussedTrack = foundTrack
                    break
                }
            }

            const projectContext = {
                userQuery: text,
                modelId: config.modelId,
                providerId: provider ? provider.id : undefined,
                forceAgentMode: config.forceAgentMode,
                project: (this.studio && this.studio.hasProfile) ? {
                    bpm: this.studio.project.timelineBox.bpm.getValue(),
                    genre: this.studio.profile.meta.name,
                    trackCount: this.studio.project.rootBoxAdapter.audioUnits.adapters().length,
                    trackList: trackList,
                    selectionSummary: this.safeInspectSelection(),
                    loopEnabled: this.studio.transport.loop.getValue(),
                    // [ANTIGRAVITY] Smart Focus Hints
                    focusHints: {
                        selectedTrack: selectedTrack,
                        recentlyDiscussedTrack: recentlyDiscussedTrack,
                        hint: selectedTrack
                            ? `User currently has "${selectedTrack}" selected. If they refer to "the track" or "it", they likely mean this.`
                            : recentlyDiscussedTrack
                                ? `We were recently discussing "${recentlyDiscussedTrack}". If the user refers to "it" or "the track", they might mean this.`
                                : "No track is currently focused. Ask the user which track if their question is track-specific."
                    }
                } : undefined,
                activeLesson: schoolStore.currentLesson.getValue() ? {
                    id: schoolStore.currentLesson.getValue()!.id,
                    title: schoolStore.currentLesson.getValue()!.title,
                    content: schoolStore.currentLesson.getValue()!.content
                } : undefined
            }

            console.log("🧠 OdieService: Context Payload", projectContext)

            // Generate the Brain's instruction for this turn
            const systemPrompt = await odiePersona.generateSystemPrompt(projectContext)

            // [ANTIGRAVITY] Cognitive Preset Injection
            const focus = await import("./services/OdieFocusService").then(m => m.odieFocus.getFocus())
            const roleAny = odiePersona.mapFocusToRole(projectContext, focus)
            const cognitiveProfile = odiePersona.getCognitiveProfile(roleAny)

            // Inject into Context for debug visibility & Provider consumption
            if (cognitiveProfile) {
                (projectContext as any).thinkingLevel = cognitiveProfile.thinkingLevel
            }

            const systemMsg: Message = { id: "system-turn", role: "system", content: systemPrompt, timestamp: Date.now() }

            // Filter out old system messages and inject the fresh one
            const cleanHistory = [...startMsgs, userMsg].filter(m => m.role !== "system")
            const history = [systemMsg, ...cleanHistory]

            // [ANTIGRAVITY] DIAGNOSTIC PORT: Update Debug Info
            // This is the "Glass Box" snapshot
            this.lastDebugInfo.setValue({
                systemPrompt: systemPrompt,
                projectContext: projectContext,
                userQuery: text,
                timestamp: Date.now()
            })

            // -- WIRED NERVOUS SYSTEM --
            // We pass OdieTools to the LLM.
            // onFinal is called when the message finishes. We check for tool calls there.
            // [ANTIGRAVITY] DUAL-BRAIN: Passing projectContext so Image Model can "See" the music context.

            // Status Callback: Propagate Gemini status updates to UI
            const handleStatus = (status: string, model?: string) => {
                this.activityStatus.setValue(status)
                if (model) this.activeModelName.setValue(model)
            }

            this.isGenerating.setValue(true) // START THINKING
            const stream = await this.ai.streamChat(history, projectContext, OdieTools, async (finalMsg) => {
                this.isGenerating.setValue(false) // STOP THINKING
                this.activityStatus.setValue("Ready") // Reset status
                this.activeModelName.setValue("Gemini") // Reset model label
                console.log("⚡ Odie Reflex Arc: Final Message Received:", finalMsg)

                if (finalMsg.tool_calls && finalMsg.tool_calls.length > 0) {
                    this.isGenerating.setValue(true) // RE-THINKING (TOOL EXECUTION)
                    const successes: string[] = []  // For display, no AI follow-up
                    const failures: string[] = []   // For structured tool errors
                    const errors: string[] = []     // For AI follow-up
                    const analysisResults: { name: string; result: string }[] = [] // For analysis tools that need AI interpretation
                    if (this.appControl) {
                        console.log("⚡ Odie Reflex Arc: Executing Tool Calls...", finalMsg.tool_calls)

                        for (const call of finalMsg.tool_calls) {
                            try {
                                let success = false


                                // [ANTIGRAVITY] Refactored Tool Execution
                                const executorContext: ExecutorContext = {
                                    studio: this.studio!,
                                    appControl: this.appControl,
                                    ai: this.ai,
                                    setGenUiPayload: (payload: any) => this.genUiPayload.setValue(payload),
                                    setSidebarVisible: (visible: boolean) => this.visible.setValue(visible),
                                    contextState: this.ai.contextService.state.getValue(),
                                    recentMessages: this.messages.getValue()
                                }

                                const result = await this.toolExecutor.execute(call, executorContext)

                                if (result.userMessage) {
                                    if (result.success) successes.push(result.userMessage)
                                    else failures.push(result.userMessage)
                                }

                                if (result.systemError) {
                                    errors.push(result.systemError)
                                    // Mirror behavior: Show dialog for errors
                                    // Though OdieToolExecutor doesn't do UI, we do it here if it's an error
                                    if (result.systemError.startsWith("❌")) {
                                        // Simple heuristic to extract msg
                                        Dialogs.info({
                                            headline: `Odie Failed: ${call.name}`,
                                            message: result.systemError.replace("❌ Error: ", "")
                                        })
                                    }
                                }

                                if (result.analysisData) {
                                    analysisResults.push({ name: call.name, result: result.analysisData })
                                    success = true
                                } else {
                                    success = result.success
                                }


                                if (!success && call.name !== "arrangement_list_tracks") {
                                    // [ANTIGRAVITY] Legacy generic hints removed.
                                    // We now rely on specific error messages in 'failures' array.
                                    // errors.push(`❌ Failed: ${call.name}.`)
                                }
                            } catch (e) {
                                console.error("Tool Execution Failed", e)
                                const errMsg = (e instanceof Error) ? e.message : String(e)
                                errors.push(`❌ Error: ${call.name} - ${errMsg}`)

                                // 🚨 VISIBLE ERROR REPORTING FOR USER
                                Dialogs.info({
                                    headline: `Odie Failed: ${call.name}`,
                                    message: errMsg
                                })
                            }
                        }
                    }

                    // --- FEEDBACK LOOP (AGENTIC RECURSION) ---
                    if (errors.length > 0) {
                        // ERRORS occurred - trigger full AI follow-up to explain
                        const feedbackMsg: Message = {
                            id: crypto.randomUUID(),
                            role: "system",
                            content: errors.join("\n"),
                            timestamp: Date.now()
                        }

                        // 1. Replace the orphan placeholder with feedback, preserve ID for follow-up stream
                        const currentMessages = this.messages.getValue()
                        const originalIdx = currentMessages.findIndex(m => m.id === assistantMsg.id)

                        // Insert feedbackMsg before the placeholder, and keep the placeholder for the follow-up
                        if (originalIdx !== -1) {
                            const newMessages = [...currentMessages]
                            newMessages.splice(originalIdx, 0, feedbackMsg)
                            this.messages.setValue(newMessages)
                        } else {
                            this.messages.setValue([...currentMessages, feedbackMsg])
                        }

                        // 2. Recurse: Send Tool Output back to Brain
                        console.log("🧠 Odie Agentic Loop: Sending feedback to model...")
                        const nextHistory = [...history, finalMsg, feedbackMsg]

                        const nextStream = this.ai.streamChat(nextHistory, undefined, OdieTools, async () => {
                            console.log("✅ Odie Agentic Loop: Turn Complete")
                        })

                        nextStream.subscribe(obs => {
                            const newText = obs.getValue()
                            const all = this.messages.getValue()
                            const targetIdx = all.findIndex(m => m.id === assistantMsg.id)
                            if (targetIdx === -1) return

                            const newAll = [...all]
                            newAll[targetIdx] = {
                                ...newAll[targetIdx],
                                content: newText || "..."
                            }
                            this.messages.setValue(newAll)
                        })
                    } else if (analysisResults.length > 0) {
                        // ANALYSIS tools need AI follow-up to explain results
                        // Create proper function response messages for each result
                        const functionResponseMsgs: Message[] = analysisResults.map(ar => ({
                            id: crypto.randomUUID(),
                            role: "function" as const,
                            name: ar.name,
                            content: ar.result,
                            timestamp: Date.now()
                        }))

                        // Show "Analyzing..." status first
                        const currentMessages = this.messages.getValue()
                        const originalIdx = currentMessages.findIndex(m => m.id === assistantMsg.id)
                        if (originalIdx !== -1) {
                            const newMessages = [...currentMessages]
                            newMessages[originalIdx] = { ...newMessages[originalIdx], content: successes.join("\n") }
                            this.messages.setValue(newMessages)
                        }

                        // Send function responses back to AI for interpretation
                        // Per Gemini spec: Model's tool call -> functionResponse(s) -> Model explains
                        // Allow render_widget for Gen UI, but exclude analysis tools to prevent loops
                        const renderOnlyTools = OdieTools.filter(t => t.name === "render_widget")
                        console.log("🧠 Odie Analysis Loop: Sending function responses to model for explanation...")
                        const nextHistory = [...history, finalMsg, ...functionResponseMsgs]

                        let lastStreamContent = ""
                        const nextStream = this.ai.streamChat(nextHistory, undefined, renderOnlyTools, async (finalResponse) => {
                            console.log("✅ Odie Analysis Loop: Explanation Complete")
                            console.log("🔬 [Analysis Loop] Final response:", {
                                hasContent: !!finalResponse.content,
                                contentLength: finalResponse.content?.length || 0,
                                hasToolCalls: !!(finalResponse.tool_calls && finalResponse.tool_calls.length > 0),
                                toolCalls: finalResponse.tool_calls?.map(tc => tc.name)
                            })

                            // If no content was streamed but we completed, check for empty response
                            // Use Gen UI to show clickable track options for better UX!
                            if (!lastStreamContent && !finalResponse.content) {
                                const trackList = this.safeListTracks().filter(t => t !== "Output")
                                const genUIFallback = `I analyzed the data but need more context. Which track's reverb would you like to fix?\n\n\`\`\`json
${JSON.stringify({
                                    ui_component: "step_list",
                                    data: {
                                        title: "Select a track:",
                                        steps: trackList.map(t => `🎚️ ${t}`)
                                    }
                                }, null, 2)}
\`\`\`\n\n*Tap a track above, or type the name to continue!*`

                                const all = this.messages.getValue()
                                const targetIdx = all.findIndex(m => m.id === assistantMsg.id)
                                if (targetIdx !== -1) {
                                    const newAll = [...all]
                                    newAll[targetIdx] = {
                                        ...newAll[targetIdx],
                                        content: genUIFallback
                                    }
                                    this.messages.setValue(newAll)
                                }
                            }
                        })

                        nextStream.subscribe(obs => {
                            const newText = obs.getValue()
                            lastStreamContent = newText || ""
                            console.log(`🔄 [Analysis Loop] Stream update received:`, newText?.substring(0, 100) || "(empty)")
                            const all = this.messages.getValue()
                            const targetIdx = all.findIndex(m => m.id === assistantMsg.id)
                            if (targetIdx === -1) {
                                console.warn("⚠️ [Analysis Loop] Target message not found in messages array!")
                                return
                            }

                            const newAll = [...all]
                            newAll[targetIdx] = {
                                ...newAll[targetIdx],
                                content: newText || "Analyzing..."
                            }
                            this.messages.setValue(newAll)
                        })
                    } else if (successes.length > 0 || failures.length > 0) {
                        // SUCCESS or PARTIAL - tools executed, display results
                        const parts = [...successes, ...failures]
                        const brief = parts.join("\n") + " [[STATUS: OK]]"
                        const all = this.messages.getValue()
                        const targetIdx = all.findIndex(m => m.id === assistantMsg.id)
                        if (targetIdx !== -1) {
                            const newAll = [...all]
                            newAll[targetIdx] = {
                                ...newAll[targetIdx],
                                content: brief
                            }
                            this.messages.setValue(newAll)
                            console.log("✅ Odie Silent Success: Tools executed, brief confirmation sent.")
                        }
                    }
                }

                // [ANTIGRAVITY] DONE THINKING
                this.isGenerating.setValue(false)

                // [ANTIGRAVITY] SIGNAL DISPATCH - Event Driven Test Rig
                this.studio?.odieEvents.notify({
                    type: "thought-complete",
                    content: this.messages.getValue().at(-1)?.content || ""
                })

            }, handleStatus)

            // Subscribe to the stream (ObservableValue emits itself on change)
            // CRITICAL: Update by message ID, not position, to prevent overwriting other messages (e.g., /verify report)
            const targetMsgId = assistantMsg.id
            const disposer = stream.subscribe((observable) => {
                const newText = observable.getValue()

                const all = this.messages.getValue()
                const targetIdx = all.findIndex(m => m.id === targetMsgId)
                if (targetIdx === -1) return // Message was removed, stop updating

                const newAll = [...all]
                newAll[targetIdx] = {
                    ...newAll[targetIdx],
                    content: newText || "..."
                }
                this.messages.setValue(newAll)
            })
            // We should store disposer to clean up later, but for now just silence the lint
            void disposer

        } catch (e) {
            console.error("Chat Error", e)
            const all = this.messages.getValue()
            const errMsg = (e instanceof Error) ? e.message : String(e)
            const newAll = [...all]
            let content = `Error: ${errMsg}`

            // [ANTIGRAVITY] Intercept 404 / Model Not Found (Sync Error)
            if (errMsg.includes("404") || errMsg.includes("Not Found") || errMsg.includes("Failed to fetch")) {
                content = "```json\n" + JSON.stringify({
                    ui_component: "error_card",
                    data: {
                        title: "Connection Failed",
                        message: "We couldn't connect to the AI service. Please check your settings and ensure the local server is running.",
                        actions: [
                            { label: "⚙️ Open Settings", id: "open_settings" },
                            { label: "↻ Retry", id: "retry_connection" }
                        ]
                    }
                }, null, 2) + "\n```"
            }

            newAll[newAll.length - 1] = {
                ...newAll[newAll.length - 1],
                role: "model",
                content: content
            }
            this.messages.setValue(newAll)

            // [ANTIGRAVITY] ERROR STOP
            this.isGenerating.setValue(false)
        }
    }

    // --- HISTORY MANAGEMENT ---

    private activeSessionId: string | null = null

    public startNewChat() {
        this.activeSessionId = crypto.randomUUID()
        this.messages.setValue([])

        // Initial Greeting
        // this.messages.setValue([{ id: "init", role: "model", content: "New session started.", timestamp: Date.now() }])
    }

    public loadSession(sessionId: string) {
        const session = chatHistory.getSession(sessionId)
        if (session) {
            this.activeSessionId = session.id
            this.messages.setValue(session.messages)
        }
    }

    private saveCurrentSession() {
        if (!this.activeSessionId) {
            this.activeSessionId = crypto.randomUUID()
        }

        const msgs = this.messages.getValue()
        if (msgs.length === 0) return

        // Auto-Title based on first user message
        const firstUserMsg = msgs.find(m => m.role === "user")
        const title = firstUserMsg ? firstUserMsg.content.slice(0, 30) + (firstUserMsg.content.length > 30 ? "..." : "") : "New Chat"

        chatHistory.saveSession({
            id: this.activeSessionId,
            title: title,
            timestamp: Date.now(),
            messages: msgs
        })
    }

    private safeListTracks(): string[] {
        try {
            return this.appControl ? this.appControl.listTracks() : []
        } catch (e) {
            return []
        }
    }

    private safeInspectSelection(): string {
        try {
            return this.appControl ? this.appControl.inspectSelection() : ""
        } catch (e) {
            return ""
        }
    }

    /**
     * [A2UI] Handle Widget Action
     * Bridges Gen UI widget interactions (like knob adjustments) to OdieAppControl.
     * Adds a confirmation message to the chat.
     */
    async handleWidgetAction(action: {
        type: string
        name: string
        componentId: string
        context: {
            param?: string
            // [Universal Control]
            deviceType?: "mixer" | "effect" | "instrument"
            deviceIndex?: number
            paramPath?: string
            // ---
            trackName?: string
            value?: number | string
            previousValue?: number
            _targetGridId?: string // Check for our new hidden ID
            actionId?: string
        }
    }) {
        if (!this.appControl) {
            console.warn("🧠 [Gen UI] Widget action received but no appControl available")
            return
        }

        const { param, trackName, value, _targetGridId, deviceType, deviceIndex, paramPath } = action.context

        try {
            let result: { success: boolean; reason?: string } | undefined
            let feedbackMessage = ""

            if (action.name === "knob_adjust" && typeof value === 'number') {
                if (param === "volume" && trackName) {
                    result = await this.appControl.setVolume(trackName, value)
                    feedbackMessage = result?.success
                        ? `✓ ${trackName} volume set`
                        : `✗ Failed to set volume`
                } else if (param === "pan" && trackName) {
                    result = await this.appControl.setPan(trackName, value)
                    feedbackMessage = result?.success
                        ? `✓ ${trackName} pan set`
                        : `✗ Failed to set pan`
                } else if (deviceType && paramPath && trackName) {
                    // [Universal Control] Generic Parameter
                    result = await this.appControl.setDeviceParam(
                        trackName,
                        deviceType,
                        // Default to 0 if undefined (safe for instruments/mixer, logic handles effects)
                        deviceIndex ?? 0,
                        paramPath,
                        value
                    )
                    feedbackMessage = result?.success
                        // E.g. "✓ frequency set" (cleaner than full path in toast)
                        ? `✓ ${paramPath.split('.').pop()} set`
                        : `✗ Failed: ${result?.reason || "Unknown error"}`

                    console.log(`🎛️ [Gen UI] Universal: ${trackName} ${deviceType}[${deviceIndex}] ${paramPath} -> ${value}`)
                } else {
                    // Fallback for legacy "param" without deviceType (should be handled by vol/pan checks above)
                    // If we get here, it's a truly unknown parameter
                    feedbackMessage = `? ${param || "param"} adjusted`
                    console.warn(`🎛️ [Gen UI] Unhandled parameter: ${param} (No deviceType provided)`)
                }

                // [TRANSIENT FEEDBACK UPDATE]
                // If we have a Grid Target, DO NOT SPAM CHAT. Show toast instead.
                if (_targetGridId) {
                    const gridEl = document.getElementById(_targetGridId)
                    const toastEl = gridEl?.querySelector(".grid-status-toast") as HTMLElement

                    if (toastEl) {
                        toastEl.textContent = feedbackMessage.replace("✓ ", "") // Make it cleaner
                        toastEl.style.opacity = "1"

                        // Clear debounce
                        // @ts-ignore
                        clearTimeout(gridEl._toastTimeout)
                        // @ts-ignore
                        gridEl._toastTimeout = setTimeout(() => {
                            toastEl.style.opacity = "0"
                        }, 2000)

                        // RETURN EARLY - DO NOT ADD TO CHAT
                        return
                    }
                }
            } else if (action.name === "step_select") {
                // Handle List Selection -> Continue Conversation
                const selection = action.context.value
                console.log(`📋 [Gen UI] User selected step: ${selection}`)

                // Add user message to chat to mimic them typing it
                this.sendMessage(String(selection))
            } else if (action.name === "error_action" && action.context.actionId) {
                this.handleErrorAction(action.context.actionId)
            }

            // Fallback: Add feedback message to chat if not handled by toast
            if (feedbackMessage) {
                const msgs = [...this.messages.getValue()]
                msgs.push({
                    id: crypto.randomUUID(),
                    role: "system",
                    content: feedbackMessage,
                    timestamp: Date.now()
                })
                this.messages.setValue(msgs)
            }

        } catch (e) {
            console.error("🧠 [Gen UI] Widget action failed:", e)
        }
    }

    private async handleErrorAction(actionId: string) {
        if (actionId === "open_settings") {
            this.viewState.setValue("settings")
            // Visual feedback handled by view switch
        } else if (actionId === "retry_connection") {
            // Re-validate logic could go here
            this.sendMessage("retry connection")
        }
    }

}


