import { DefaultObservableValue, Terminator } from "@opendaw/lib-std"
import type { StudioService } from "../../service/StudioService"
import { AIService } from "./services/AIService"


import { Message } from "./services/llm/LLMProvider"
import { OdieAppControl } from "./services/OdieAppControl"
import { odiePersona, OdieContext } from "./services/OdiePersonaService"
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
    readonly visible = new DefaultObservableValue<boolean>(false)

    // Activity State for UI
    readonly isGenerating = new DefaultObservableValue<boolean>(false)
    readonly activeModelName = new DefaultObservableValue<string>("Gemini")
    readonly activityStatus = new DefaultObservableValue<string>("Ready")

    // Connection State for Status Indicator
    // Values: "unknown" | "connected" | "disconnected" | "checking"
    readonly connectionStatus = new DefaultObservableValue<"unknown" | "connected" | "disconnected" | "checking">("checking")

    // Interface State
    readonly genUiPayload = new DefaultObservableValue<import("./genui/GenUISchema").GenUIPayload | null>(null)

    // Diagnostic Info
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
    readonly #toolExecutor = new OdieToolExecutor()



    // Studio Control
    public appControl?: OdieAppControl

    public studio?: StudioService

    readonly #terminator = new Terminator()
    constructor() {
        // Expose for debugging
        if (typeof window !== "undefined" && import.meta.env.DEV) {
            ; (window as any).odie = this;
        }

        try {
            // Default to chat view
            this.viewState.setValue("chat")

            // Auto-Save History
            this.#terminator.own(this.messages.subscribe(() => {
                this.saveCurrentSession()
            }))

            // Model Indicator Sync
            this.#terminator.own(this.ai.activeProviderId.subscribe(observer => {
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

                this.validateConnection()
            }))
            // Initial Sync
            const currentId = this.ai.activeProviderId.getValue()
            if (currentId === "ollama") {
                const config = this.ai.getConfig("ollama")
                this.activeModelName.setValue(config.modelId || "Local")
            } else if (currentId === "gemini-3") {
                this.activeModelName.setValue("Gemini 3")
            }

            this.validateConnection()

            // History Sync
            this.activeSessionId = null
            chatHistory.sessions.subscribe(observer => {
                if (this.activeSessionId) {
                    const sessions = observer.getValue()
                    const exists = sessions.find((s: { id: string }) => s.id === this.activeSessionId)
                    if (!exists) {
                        this.startNewChat()
                    }
                }
            })

        } catch (e) {
            console.error("🔥 OdieService Constructor CRASH:", e)
        }
    }

    // Validate API Connection for active provider
    async validateConnection(): Promise<void> {
        this.connectionStatus.setValue("checking")
        const provider = this.ai.getActiveProvider()

        if (!provider) {
            this.connectionStatus.setValue("disconnected")
            return
        }

        // Check if provider has a validate method
        if (typeof provider.validate === "function") {
            try {
                const result = await provider.validate()
                this.connectionStatus.setValue(result.ok ? "connected" : "disconnected")
            } catch (e) {
                this.connectionStatus.setValue("disconnected")
            }
        } else {
            this.connectionStatus.setValue("connected")
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
        try {
            if (!OdieAppControl) {
                throw new Error("OdieAppControl is undefined");
            }
            this.appControl = new OdieAppControl(studio)
        } catch (e) {
            console.error("Failed to load OdieAppControl:", e);
        }
    }

    async sendMessage(text: string) {
        // Command Interception
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

        // Fast Path Interaction
        const fastPathMap: Array<[RegExp, string, (match: RegExpMatchArray) => string[]]> = [
            [/^play$/i, "/play", () => []],
            [/^start$/i, "/play", () => []],
            [/^stop$/i, "/stop", () => []],
            [/^pause$/i, "/stop", () => []],
            [/^record$/i, "/record", () => []],
            [/^list$/i, "/list", () => []],
            [/^list tracks$/i, "/list", () => []],
            [/^add (.*) track$/i, "/add", (m) => [m[1]]],
            [/^add (.*)$/i, "/add", (m) => [m[1]]],
            [/^new project$/i, "/new", () => []],
            [/^clear$/i, "/new", () => []],
        ]

        for (const [regex, cmd, getArgs] of fastPathMap) {
            const match = text.trim().match(regex)
            if (match) {
                if (commandRegistry.has(cmd)) {
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

        // Standard AI Interaction
        const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text, timestamp: Date.now() }
        const startMsgs = this.messages.getValue()
        this.messages.setValue([...startMsgs, userMsg])

        // Placeholder for streaming response
        const assistantMsg: Message = { id: crypto.randomUUID(), role: "model", content: "", timestamp: Date.now() }
        this.messages.setValue([...startMsgs, userMsg, assistantMsg])



        try {
            const provider = this.ai.getActiveProvider()
            const config = provider ? this.ai.getConfig(provider.id) : {}
            const needsSetup = !provider || (provider.id !== "ollama" && (!config.apiKey || config.apiKey.length < 5))

            if (needsSetup) {
                const errorCard = {
                    ui_component: "error_card",
                    data: {
                        title: "Setup Required",
                        message: "Please connect an AI provider in settings.",
                        actions: [
                            { label: "Settings", id: "open_settings" }
                        ]
                    }
                }

                // Return immediate "Model" response with card
                const sysMsg: Message = {
                    id: (Date.now() + 1).toString(),
                    role: "model",
                    content: "```json\n" + JSON.stringify(errorCard, null, 2) + "\n```",
                    timestamp: Date.now()
                }
                const currentPostExec = this.messages.getValue()
                this.messages.setValue([...currentPostExec, sysMsg])
                return
            }


            // Context Preparation
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

            const projectContext: OdieContext = {
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
                    focusHints: {
                        selectedTrack: selectedTrack,
                        recentlyDiscussedTrack: recentlyDiscussedTrack,
                        hint: selectedTrack
                            ? `User has "${selectedTrack}" selected.`
                            : recentlyDiscussedTrack
                                ? `Discussing "${recentlyDiscussedTrack}".`
                                : "No track focused."
                    }
                } : undefined
            }

            const systemPrompt = await odiePersona.generateSystemPrompt(projectContext)

            const focus = await import("./services/OdieFocusService").then(m => m.odieFocus.getFocus())
            const role = odiePersona.mapFocusToRole(projectContext, focus)
            const cognitiveProfile = odiePersona.getCognitiveProfile(role)

            if (cognitiveProfile) {
                projectContext.thinkingLevel = cognitiveProfile.thinkingLevel
            }

            const systemMsg: Message = { id: "system-turn", role: "system", content: systemPrompt, timestamp: Date.now() }

            const cleanHistory = [...startMsgs, userMsg].filter(m => m.role !== "system")
            const history = [systemMsg, ...cleanHistory]

            this.lastDebugInfo.setValue({
                systemPrompt: systemPrompt,
                projectContext: projectContext,
                userQuery: text,
                timestamp: Date.now()
            })

            // Stream standard chat interaction
            const handleStatus = (status: string, model?: string) => {
                this.activityStatus.setValue(status)
                if (model) this.activeModelName.setValue(model)
            }

            this.isGenerating.setValue(true)
            const stream = await this.ai.streamChat(history, projectContext, OdieTools, async (finalMsg) => {
                this.isGenerating.setValue(false)
                this.activityStatus.setValue("Ready")
                // this.activeModelName.setValue("Gemini")

                if (finalMsg.tool_calls && finalMsg.tool_calls.length > 0) {
                    this.isGenerating.setValue(true)
                    const successes: string[] = []
                    const failures: string[] = []
                    const errors: string[] = []
                    const analysisResults: { name: string; result: string }[] = []
                    if (this.appControl) {
                        for (const call of finalMsg.tool_calls) {
                            try {
                                const executorContext: ExecutorContext = {
                                    studio: this.studio!,
                                    appControl: this.appControl,
                                    ai: this.ai,
                                    setGenUiPayload: (payload: unknown) => this.genUiPayload.setValue(payload as any),
                                    setSidebarVisible: (visible: boolean) => this.visible.setValue(visible),
                                    contextState: this.ai.contextService.state.getValue(),
                                    recentMessages: this.messages.getValue()
                                }

                                const result = await this.#toolExecutor.execute(call, executorContext)

                                if (result.userMessage) {
                                    if (result.success) successes.push(result.userMessage)
                                    else failures.push(result.userMessage)
                                }

                                if (result.systemError) {
                                    errors.push(result.systemError)
                                    if (result.systemError.startsWith("❌")) {
                                        Dialogs.info({
                                            headline: `Tool Failed: ${call.name}`,
                                            message: result.systemError.replace("❌ Error: ", "")
                                        })
                                    }
                                }

                                if (result.analysisData) {
                                    analysisResults.push({ name: call.name, result: result.analysisData })
                                }
                            } catch (e) {
                                const errMsg = (e instanceof Error) ? e.message : String(e)
                                errors.push(`❌ Error: ${call.name} - ${errMsg}`)

                                Dialogs.info({
                                    headline: `Tool Failed: ${call.name}`,
                                    message: errMsg
                                })
                            }
                        }
                    }

                    // Feedback Loop
                    if (errors.length > 0) {
                        const feedbackMsg: Message = {
                            id: crypto.randomUUID(),
                            role: "system",
                            content: errors.join("\n"),
                            timestamp: Date.now()
                        }

                        const currentMessages = this.messages.getValue()
                        const originalIdx = currentMessages.findIndex(m => m.id === assistantMsg.id)

                        if (originalIdx !== -1) {
                            const newMessages = [...currentMessages]
                            newMessages.splice(originalIdx, 0, feedbackMsg)
                            this.messages.setValue(newMessages)
                        } else {
                            this.messages.setValue([...currentMessages, feedbackMsg])
                        }

                        const nextHistory = [...history, finalMsg, feedbackMsg]

                        const nextStream = this.ai.streamChat(nextHistory, undefined, OdieTools, async () => {
                            console.log("Agent turn complete")
                        })

                        nextStream.subscribe(obs => {
                            const val = obs.getValue()
                            const newText = val.content
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
                        const functionResponseMsgs: Message[] = analysisResults.map(ar => ({
                            id: crypto.randomUUID(),
                            role: "function" as const,
                            name: ar.name,
                            content: ar.result,
                            timestamp: Date.now()
                        }))

                        const currentMessages = this.messages.getValue()
                        const originalIdx = currentMessages.findIndex(m => m.id === assistantMsg.id)
                        if (originalIdx !== -1) {
                            const newMessages = [...currentMessages]
                            newMessages[originalIdx] = { ...newMessages[originalIdx], content: successes.join("\n") }
                            this.messages.setValue(newMessages)
                        }

                        const renderOnlyTools = OdieTools.filter(t => t.name === "render_widget")
                        const nextHistory = [...history, finalMsg, ...functionResponseMsgs]

                        let lastStreamContent = ""
                        const nextStream = this.ai.streamChat(nextHistory, undefined, renderOnlyTools, async (finalResponse) => {
                            if (!lastStreamContent && !finalResponse.content) {
                                const trackList = this.safeListTracks().filter(t => t !== "Output")
                                const genUIFallback = `Context needed. Which track would you like to update?\n\n\`\`\`json
${JSON.stringify({
                                    ui_component: "step_list",
                                    data: {
                                        title: "Select a track:",
                                        steps: trackList.map(t => `🎚️ ${t}`)
                                    }
                                }, null, 2)}
\`\`\`\n\n*Select a track above to continue.*`

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
                            const val = obs.getValue()
                            const newText = val.content
                            lastStreamContent = newText || ""
                            const all = this.messages.getValue()
                            const targetIdx = all.findIndex(m => m.id === assistantMsg.id)
                            if (targetIdx === -1) return

                            const newAll = [...all]
                            newAll[targetIdx] = {
                                ...newAll[targetIdx],
                                content: newText || "Processing..."
                            }
                            this.messages.setValue(newAll)
                        })
                    } else if (successes.length > 0 || failures.length > 0) {
                        const parts = [...successes, ...failures]
                        const brief = parts.join("\n")
                        const all = this.messages.getValue()
                        const targetIdx = all.findIndex(m => m.id === assistantMsg.id)
                        if (targetIdx !== -1) {
                            const newAll = [...all]
                            newAll[targetIdx] = {
                                ...newAll[targetIdx],
                                content: newAll[targetIdx].content ? `${newAll[targetIdx].content}\n\n${brief}` : brief
                            }
                            this.messages.setValue(newAll)
                        }
                    }
                }

                this.isGenerating.setValue(false)

                this.studio?.odieEvents.notify({
                    type: "action-complete",
                    content: this.messages.getValue().at(-1)?.content || ""
                })

            }, handleStatus)



            // Subscribe to the stream (ObservableValue emits itself on change)
            // CRITICAL: Update by message ID, not position, to prevent overwriting other messages (e.g., /verify report)
            const targetMsgId = assistantMsg.id
            const disposer = stream.subscribe((observable) => {
                const val = observable.getValue()
                const newText = val.content
                const thoughts = val.thoughts

                const all = this.messages.getValue()
                const targetIdx = all.findIndex(m => m.id === targetMsgId)
                if (targetIdx === -1) return // Message was removed, stop updating

                const newAll = [...all]
                newAll[targetIdx] = {
                    ...newAll[targetIdx],
                    content: newText || "...",
                    thoughts: thoughts
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

            // Intercept 404 / Model Not Found (Sync Error)
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

            this.isGenerating.setValue(false)
        }
    }


    // History Management

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
     * Handle Interface Widget Action
     */
    async handleWidgetAction(action: any) {
        /*
        action: {
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
        }
        */
        if (!this.appControl) {
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
                        const grid = gridEl as any
                        clearTimeout(grid._toastTimeout)
                        grid._toastTimeout = setTimeout(() => {
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


