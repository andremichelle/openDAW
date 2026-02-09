
import { DefaultObservableValue, Terminator, isAbsent, isDefined, Nullable, Option as StdOption } from "@opendaw/lib-std"
import type { StudioService } from "../../service/StudioService"
import { AIService } from "./services/AIService"



import type { JsonValue, Message, LLMProvider } from "./services/llm/LLMProvider"
import { OdieAppControl } from "./services/OdieAppControl"
import { odiePersona, OdieContext } from "./services/OdiePersonaService"
import { chatHistory } from "./services/ChatHistoryService"
import { OdieTools } from "./services/OdieToolDefinitions"
import { commandRegistry } from "./services/OdieCommandRegistry"
import { OdieToolExecutor } from "./services/OdieToolExecutor"
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

    #saveTimeout: any = undefined



    public get appControl(): StdOption<OdieAppControl> { return this.#appControl }

    public get studio(): StdOption<StudioService> { return this.#studio }

    #appControl: StdOption<OdieAppControl> = StdOption.None

    #studio: StdOption<StudioService> = StdOption.None

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
            this.#terminator.own(this.messages.subscribe(() => {
                clearTimeout(this.#saveTimeout)
                this.#saveTimeout = setTimeout(() => {
                    this.saveCurrentSession()
                    this.#saveTimeout = undefined
                }, 5000)
            }))

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
        this.#studio = StdOption.wrap(studio)
        this.ai.setStudio(studio)
        try {
            // OdieAppControl is imported class, check unnecessary
            this.#appControl = StdOption.wrap(new OdieAppControl(studio))
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
        const startMsgsWithUser = this.messages.getValue()
        this.messages.setValue([...startMsgsWithUser, assistantMsg])

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

                // Update assistant message in-place
                const allMsgs = this.messages.getValue()
                this.messages.setValue(allMsgs.map(m => m.id === assistantMsg.id ? {
                    ...m,
                    content: `\`\`\`json\n${JSON.stringify(errorCard, null, 2)}\n\`\`\``
                } : m))
                return
            }

            // Placeholder for Context & Stream
            await this.sendMessageStream(text, assistantMsg, provider, config)

        } catch (e) {
            console.error("Chat Error", e)
            // Error handling logic (simplified for now)
            this.isGenerating.setValue(false)
        }

    }

    private async sendMessageStream(text: string, assistantMsg: Message, provider: LLMProvider, config: any) {
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
            if (isAbsent(msg.content) || msg.id === assistantMsg.id) continue
            const msgLower = msg.content.toLowerCase()
            const foundTrack = trackList.find(t => msgLower.includes(t.toLowerCase()))
            if (isDefined(foundTrack)) {
                recentlyDiscussedTrack = foundTrack
                break
            }
        }

        const studio = this.studio.isEmpty() ? null : this.studio.unwrap()
        const projectContext: OdieContext = {
            userQuery: text,
            modelId: config.modelId,
            providerId: provider ? provider.id : undefined,
            forceAgentMode: config.forceAgentMode,
            project: (studio && studio.hasProfile) ? {
                bpm: studio.project.timelineBox.bpm.getValue(),
                genre: studio.profile.meta.name,
                trackCount: studio.project.rootBoxAdapter.audioUnits.adapters().length,
                trackList: trackList,
                selectionSummary: await this.safeInspectSelection(),
                loopEnabled: studio.transport.loop.getValue(),
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

        const allMsgs = this.messages.getValue()
        const cleanHistory = allMsgs.filter(m => m.id !== assistantMsg.id && m.role !== "system")
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

        // Stream handling
        const stream = await this.ai.streamChat(history, projectContext, OdieTools, async (finalMsg) => {
            let followUpStarted = false
            this.activityStatus.setValue("Ready")

            if (finalMsg.tool_calls && finalMsg.tool_calls.length > 0) {
                // Execute tools only if we have required context
                if (this.studio.nonEmpty() && this.appControl.nonEmpty()) {
                    await this.#toolExecutor.executeToolCalls(finalMsg.tool_calls, {
                        studio: this.studio.unwrap(),
                        appControl: this.appControl.unwrap(),
                        ai: this.ai,
                        setGenUiPayload: (p) => {
                            console.log("GenUI Payload:", p)
                        },
                        setSidebarVisible: (_v) => {
                            // Note: viewState doesn't have 'closed', just show chat when visible
                            this.viewState.setValue("chat")
                        },
                        contextState: { focus: this.ai.contextService.state.getValue().focus as unknown as JsonValue },
                        recentMessages: this.messages.getValue()
                    })
                } else {
                    console.warn("⚠️ [OdieService] Cannot execute tools: studio or appControl not available")
                }
            }

            if (!followUpStarted) {
                this.isGenerating.setValue(false)
            }

            this.studio.ifSome(s => s.odieEvents.notify({
                type: "action-complete",
                content: this.messages.getValue().at(-1)?.content || ""
            }))
        }, handleStatus)

        // Subscribe
        const targetMsgId = assistantMsg.id
        const disposer = stream.subscribe((observable) => {
            const val = observable.getValue()
            const newText = val.content
            const thoughts = val.thoughts

            const all = this.messages.getValue()
            const targetIdx = all.findIndex(m => m.id === targetMsgId)
            if (targetIdx === -1) return

            const newAll = [...all]
            newAll[targetIdx] = {
                ...newAll[targetIdx],
                content: newText || "...",
                thoughts: thoughts
            }
            this.messages.setValue(newAll)
        })
        this.#chatTerminator.own(disposer)
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
        const title = (isDefined(firstUserMsg) && isDefined(firstUserMsg.content)) ? firstUserMsg.content.slice(0, 30) + (firstUserMsg.content.length > 30 ? "..." : "") : "New Chat"

        chatHistory.saveSession({
            id: this.activeSessionId,
            title: title,
            timestamp: Date.now(),
            messages: msgs
        })
    }


    private safeListTracks(): string[] {
        if (this.appControl.isEmpty()) return []
        return this.appControl.unwrap().listTracks()
    }

    private async safeInspectSelection(): Promise<string> {
        if (this.appControl.isEmpty()) return ""
        return (await this.appControl.unwrap().inspectSelection())?.message ?? ""
    }

    /**
     * Handle Interface Widget Action
     */
    async handleWidgetAction(action: WidgetAction) {
        console.log(`⚡ [OdieService] handleWidgetAction: ${action.name}`, action)

        if (this.appControl.isEmpty()) {
            console.warn("⚠️ [OdieService] handleWidgetAction failed: No appControl")
            return
        }

        const appControl = this.appControl.unwrap()

        try {
            let result: { success: boolean; reason?: string } | undefined
            let feedbackMessage = ""

            if (action.name === "knob_adjust") {
                const { param, trackName, value, _targetGridId, deviceType, deviceIndex, paramPath } = action.context

                if (param === "volume" && trackName) {
                    result = await appControl.setVolume(trackName, value)
                    feedbackMessage = result?.success
                        ? `✓ ${trackName} volume set`
                        : "✗ Failed to set volume"
                } else if (param === "pan" && trackName) {
                    result = await appControl.setPan(trackName, value)
                    feedbackMessage = result?.success
                        ? `✓ ${trackName} pan set`
                        : "✗ Failed to set pan"
                } else if (deviceType && paramPath && trackName) {
                    // [Universal Control] Generic Parameter
                    result = await appControl.setDeviceParam(
                        trackName,
                        deviceType,
                        deviceIndex ?? 0,
                        paramPath,
                        value
                    )
                    feedbackMessage = result?.success
                        ? `✓ ${paramPath.split('.').pop()} set`
                        : `✗ Failed: ${result?.reason || "Unknown error"}`

                    console.log(`🎛️ [Gen UI] Universal: ${trackName} ${deviceType} [${deviceIndex}] ${paramPath} -> ${value}`)
                } else {
                    feedbackMessage = `? ${param || "param"} adjusted`
                }

                if (_targetGridId) {
                    this.#studio?.ifSome(s => s.odieEvents.notify({
                        type: "ui-feedback",
                        message: feedbackMessage.replace("✓ ", ""),
                        targetId: _targetGridId
                    }))
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
        if (this.#saveTimeout) {
            clearTimeout(this.#saveTimeout)
            this.saveCurrentSession()
        }
        this.#terminator.terminate()
        this.#chatTerminator.terminate()
    }
}
