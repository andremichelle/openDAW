import { DefaultObservableValue, Terminator, isAbsent, isDefined, Nullable, Optional } from "@opendaw/lib-std"
import type { StudioService } from "../../service/StudioService"
import { AIService } from "./services/AIService"



import type { JsonValue, Message } from "./services/llm/LLMProvider"
import { OdieAppControl } from "./services/OdieAppControl"
import { odiePersona, OdieContext } from "./services/OdiePersonaService"
import { chatHistory } from "./services/ChatHistoryService"
import { OdieTools } from "./services/OdieToolDefinitions"
import { commandRegistry } from "./services/OdieCommandRegistry"
import { Dialogs } from "../components/dialogs"
import { OdieToolExecutor, ExecutorContext } from "./services/OdieToolExecutor"
import { safeUUID } from "./OdieConstants"

// ═══════════════════════════════════════════════════════════════════════════════
// Widget Action Types
// ═══════════════════════════════════════════════════════════════════════════════

type DeviceType = "mixer" | "effect" | "instrument" | "midiEffect"

interface KnobAdjustContext {
    param?: string
    trackName?: string
    value: number
    previousValue?: number
    deviceType?: DeviceType
    deviceIndex?: number
    paramPath?: string
    _targetGridId?: string
}

interface StepSelectContext {
    value: string | number
}

interface ErrorActionContext {
    actionId: string
    providerId?: string
}

interface KnobAdjustAction {
    type: "userAction"
    name: "knob_adjust"
    componentId: string
    context: KnobAdjustContext
}

interface StepSelectAction {
    type: "userAction"
    name: "step_select"
    componentId: string
    context: StepSelectContext
}

interface ErrorAction {
    type: "userAction"
    name: "error_action"
    componentId: string
    context: ErrorActionContext
}

export type WidgetAction = KnobAdjustAction | StepSelectAction | ErrorAction


export class OdieService {
    readonly messages = new DefaultObservableValue<Message[]>([])
    readonly open = new DefaultObservableValue<boolean>(false)
    readonly width = new DefaultObservableValue<number>(450)
    readonly visible = new DefaultObservableValue<boolean>(false)

    readonly isGenerating = new DefaultObservableValue<boolean>(false)
    readonly activeModelName = new DefaultObservableValue<string>("Gemini")
    readonly activityStatus = new DefaultObservableValue<string>("Ready")

    // Values: "unknown" | "connected" | "disconnected" | "checking"
    readonly connectionStatus = new DefaultObservableValue<"unknown" | "connected" | "disconnected" | "checking">("checking")

    readonly genUiPayload = new DefaultObservableValue<Nullable<import("./genui/GenUISchema").GenUIPayload>>(null)

    readonly lastDebugInfo = new DefaultObservableValue<Nullable<{
        systemPrompt: string
        projectContext: OdieContext
        userQuery: string
        timestamp: number
    }>>(null)



    readonly viewState = new DefaultObservableValue<"wizard" | "chat" | "settings">("wizard")

    readonly showHistory = new DefaultObservableValue<boolean>(false)

    readonly ai = new AIService()
    readonly #toolExecutor = new OdieToolExecutor()



    public appControl: Optional<OdieAppControl>

    public studio: Optional<StudioService>

    readonly #terminator = new Terminator()
    readonly #chatTerminator = new Terminator()

    constructor() {
        const dev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV
        if (typeof window !== "undefined" && dev) {
            ; (window as unknown as { odie: OdieService }).odie = this;
        }

        try {
            // Default to chat view
            this.viewState.setValue("chat")

            // Auto-Save History (Debounced)
            let saveTimeout: ReturnType<typeof setTimeout>
            this.#terminator.own(this.messages.subscribe(() => {
                clearTimeout(saveTimeout)
                saveTimeout = setTimeout(() => this.saveCurrentSession(), 5000)
            }))
            this.#terminator.own({
                terminate: () => clearTimeout(saveTimeout)
            })

            // Model Indicator Sync
            this.#terminator.own(this.ai.activeProviderId.subscribe(observer => {
                const id = observer.getValue()
                let label = "Unknown"
                if (isAbsent(id) || typeof id !== "string") {
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
            this.#terminator.own(chatHistory.sessions.subscribe(observer => {
                if (isDefined(this.activeSessionId)) {
                    const sessions = observer.getValue()
                    const exists = sessions.find((s: { id: string }) => s.id === this.activeSessionId)
                    if (isAbsent(exists)) {
                        this.startNewChat()
                    }
                }
            }))

        } catch (e) {
            console.error("🔥 OdieService Constructor CRASH:", e)
        }
    }

    // Validate API Connection for active provider
    async validateConnection(): Promise<void> {
        this.connectionStatus.setValue("checking")
        const provider = this.ai.getActiveProvider()

        if (isAbsent(provider)) {
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
            // OdieAppControl is imported class, check unnecessary
            this.appControl = new OdieAppControl(studio)
        } catch (e) {
            console.error("Failed to load OdieAppControl:", e);
        }
    }

    async sendMessage(text: string) {
        this.#chatTerminator.terminate()

        // Command Interception
        if (text.startsWith("/")) {
            const [cmd, ...args] = text.trim().split(" ")
            if (commandRegistry.has(cmd)) {

                // Add User Msg IMMEDIATELY
                const userMsg: Message = {
                    id: safeUUID(), role: "user", content: text, timestamp: Date.now()
                }
                const currentStart = this.messages.getValue()
                this.messages.setValue([...currentStart, userMsg])

                // Execute
                const result = await commandRegistry.execute(cmd, args, this)

                if (result) {
                    // Add System Msg (Feedback)
                    const sysMsg: Message = {
                        id: safeUUID(), role: "model", content: result, timestamp: Date.now()
                    }
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
                    const userMsg: Message = {
                        id: safeUUID(), role: "user", content: text, timestamp: Date.now()
                    }
                    const currentStart = this.messages.getValue()
                    this.messages.setValue([...currentStart, userMsg])

                    // Execute
                    const args = getArgs(match)
                    const result = await commandRegistry.execute(cmd, args, this)

                    if (isDefined(result)) {
                        const sysMsg: Message = {
                            id: safeUUID(), role: "model", content: result, timestamp: Date.now()
                        }
                        const currentPostExec = this.messages.getValue()
                        this.messages.setValue([...currentPostExec, sysMsg])
                    }
                    return
                }
            }
        }


        const userMsg: Message = {
            id: safeUUID(), role: "user", content: text, timestamp: Date.now()
        }
        const startMsgs = this.messages.getValue()
        this.messages.setValue([...startMsgs, userMsg])

        const assistantMsg: Message = {
            id: safeUUID(), role: "model", content: "", timestamp: Date.now()
        }
        this.messages.setValue([...startMsgs, userMsg, assistantMsg])



        const provider = this.ai.getActiveProvider()
        try {
            const config = isDefined(provider) ? this.ai.getConfig(provider.id) : {}
            const needsSetup = isAbsent(provider) || (provider.id !== "ollama" && (isAbsent(config.apiKey) || config.apiKey.length < 5))

            if (needsSetup) {
                const errorCard = {
                    ui_component: "error_card",
                    data: {
                        title: "Setup Required",
                        message: "Please connect an AI provider in settings.",
                        actions: [
                            {
                                label: "Settings",
                                actionId: "open_settings",
                                context: { providerId: "gemini-3" }
                            }
                        ]
                    }
                }

                // Return immediate "Model" response with card
                const sysMsg: Message = {
                    id: safeUUID(),
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
            const selectedTrack = isDefined(focusState.selectedTrackName) && trackList.includes(focusState.selectedTrackName)
                ? focusState.selectedTrackName
                : null

            // Find recently discussed track from conversation history
            const recentMessages = this.messages.getValue().slice(-6) // Last 6 messages
            let recentlyDiscussedTrack: Nullable<string> = null
            for (const msg of recentMessages.reverse()) {
                if (isAbsent(msg.content)) continue
                const msgLower = msg.content.toLowerCase()
                const foundTrack = trackList.find(t => msgLower.includes(t.toLowerCase()))
                if (isDefined(foundTrack)) {
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

            const systemMsg: Message = {
                id: "system-turn", role: "system", content: systemPrompt, timestamp: Date.now()
            }

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

                if (finalMsg.tool_calls && finalMsg.tool_calls.length > 0) {
                    this.isGenerating.setValue(true)
                    const successes: string[] = []
                    const failures: string[] = []
                    const errors: string[] = []
                    const analysisResults: { name: string; result: string }[] = []
                    if (this.appControl) {
                        for (const call of finalMsg.tool_calls) {
                            try {
                                if (!this.studio) throw new Error("Studio not initialized")

                                const executorContext: ExecutorContext = {
                                    studio: this.studio,
                                    appControl: this.appControl,
                                    setGenUiPayload: (payload: any) => this.genUiPayload.setValue(payload),
                                    setSidebarVisible: (visible: boolean) => this.visible.setValue(visible),
                                    contextState: this.ai.contextService.state.getValue() as unknown as Record<string, JsonValue>,
                                    recentMessages: this.messages.getValue(),
                                    ai: this.ai
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
                                    analysisResults.push({ name: call.name, result: typeof result.analysisData === 'string' ? result.analysisData : JSON.stringify(result.analysisData) })
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
                    } else {
                        errors.push(`Tool execution unavailable: AppControl is missing.`)
                        Dialogs.info({
                            headline: "Tools Unavailable",
                            message: "Odie cannot execute tools at this time. Please check your connection or restart the application."
                        })
                        this.isGenerating.setValue(false)
                        this.visible.setValue(false)
                        return
                    }

                    // Feedback Loop
                    if (errors.length > 0) {
                        const feedbackMsg: Message = {
                            id: safeUUID(),
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

                        const nextStream = await this.ai.streamChat(nextHistory, undefined, OdieTools, async () => {
                            console.log("Agent turn complete")
                        })

                        this.#chatTerminator.own(nextStream.subscribe(obs => {
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
                        }))
                    } else if (analysisResults.length > 0) {
                        const functionResponseMsgs: Message[] = analysisResults.map(ar => ({
                            id: safeUUID(),
                            role: "function" as const,
                            name: ar.name,
                            content: ar.result,
                            timestamp: Date.now()
                        }))

                        const currentMessages = this.messages.getValue()
                        const originalIdx = currentMessages.findIndex(m => m.id === assistantMsg.id)
                        if (originalIdx !== -1) {
                            const newMessages = [...currentMessages]
                            newMessages[originalIdx] = {
                                ...newMessages[originalIdx], content: successes.join("\n")
                            }
                            this.messages.setValue(newMessages)
                        }

                        const renderOnlyTools = OdieTools.filter(t => t.name === "render_widget")
                        const nextHistory = [...history, finalMsg, ...functionResponseMsgs]

                        let lastStreamContent = ""
                        const nextStream = await this.ai.streamChat(nextHistory, undefined, renderOnlyTools, async (finalResponse) => {
                            if (!lastStreamContent && !finalResponse.content) {
                                const trackList = this.safeListTracks().filter(t => t !== "Output")
                                const genUIFallback = `Context needed. Which track would you like to update?\n\n\`\`\`json\n${JSON.stringify({
                                    ui_component: "step_list",
                                    data: {
                                        title: "Select a track:",
                                        steps: trackList.map(t => `🎚️ ${t}`)
                                    }
                                }, null, 2)
                                    }\n\`\`\`\n\n*Select a track above to continue.*`

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

                        this.#chatTerminator.own(nextStream.subscribe(obs => {
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
                        }))
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
            this.#chatTerminator.own(disposer)

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
                            {
                                label: "⚙️ Open Settings",
                                actionId: "open_settings",
                                context: {
                                    providerId: isDefined(provider) ? provider.id : "ollama"
                                }
                            },
                            {
                                label: "↻ Retry", actionId: "retry_connection"
                            }
                        ]
                    }
                }, null, 2) + "\n```"
            }

            this.messages.setValue(newAll.map(m => m.id === assistantMsg.id ? {
                ...m,
                role: "model",
                content: content
            } : m))

            this.isGenerating.setValue(false)
        }
    }


    // History Management

    private activeSessionId: Nullable<string> = null

    public startNewChat() {
        this.activeSessionId = safeUUID()
        this.messages.setValue([])
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
            this.activeSessionId = safeUUID()
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
        return this.appControl?.listTracks() ?? []
    }

    private safeInspectSelection(): string {
        return this.appControl?.inspectSelection() ?? ""
    }

    /**
     * Handle Interface Widget Action
     */
    async handleWidgetAction(action: WidgetAction) {
        console.log(`⚡ [OdieService] handleWidgetAction: ${action.name}`, action)
        if (!this.appControl) {
            console.warn("⚠️ [OdieService] handleWidgetAction failed: No appControl")
            return
        }
        try {
            let result: { success: boolean; reason?: string } | undefined
            let feedbackMessage = ""
            if (action.name === "knob_adjust") {
                const { param, trackName, value, _targetGridId, deviceType, deviceIndex, paramPath } = action.context
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
                    // Fallback for legacy "param" without deviceType
                    feedbackMessage = `? ${param || "param"} adjusted`
                }

                if (_targetGridId) {
                    const gridEl = document.getElementById(_targetGridId)
                    const toastEl = gridEl?.querySelector(".grid-status-toast") as HTMLElement

                    if (toastEl) {
                        toastEl.textContent = feedbackMessage.replace("✓ ", "")
                        toastEl.style.opacity = "1"
                        setTimeout(() => {
                            if (toastEl) toastEl.style.opacity = "0"
                        }, 1500)
                    }
                }
            } else if (action.name === "step_select") {
                const { value } = action.context
                await this.sendMessage(String(value))
            } else if (action.name === "error_action") {
                const { actionId, providerId } = action.context
                if (actionId === "open_settings") {
                    this.viewState.setValue("settings")
                    if (providerId) {
                        this.ai.activeProviderId.setValue(providerId)
                    }
                } else if (actionId === "retry_connection") {
                    this.validateConnection()
                }
            }
        } catch (e) {
            console.error("Widget Action Error", e)
        }
    }

    dispose() {
        this.#terminator.terminate()
        this.#chatTerminator.terminate()
    }
}
