import {
    DefaultObservableValue,
    Errors,
    isDefined,
    MutableObservableOption,
    Nullable,
    ObservableOption,
    ObservableValue,
    Option,
    Optional,
    Terminable,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {Browser} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Vertex} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {ScriptHost} from "@opendaw/studio-scripting"
import {StudioService} from "@/service/StudioService"
import {StudioScriptHost} from "@/script/StudioScriptHost"
import {AgentTask} from "@/script/AgentTask"
import {AgentTaskDialog} from "@/script/AgentTaskDialog"
import {AgentTexts} from "@/script/AgentTexts"

export type AgentConnectionState = "off" | "waiting" | "connected"

export type AgentRelayMode = "server" | "local"

export type AgentToken = { readonly token: string, readonly expires: number }

type AgentToolCall = { readonly id: number, readonly kind: "tool", readonly name: string, readonly arguments: unknown }

type AgentToolResult = { readonly text: string, readonly isError: boolean }

type AgentRunResult = { readonly result: Nullable<string>, readonly error: Nullable<string> }

type AgentObject = { readonly type: string, readonly uuid: string }

type AgentContext = {
    readonly project: Nullable<string>
    readonly editingDevice: Nullable<AgentObject>
    readonly editingRegion: Nullable<AgentObject>
    readonly selection: ReadonlyArray<AgentObject>
    readonly playhead: ppqn
    readonly loop: { readonly enabled: boolean, readonly from: ppqn, readonly to: ppqn }
}

const isToolCall = (value: unknown): value is AgentToolCall =>
    typeof value === "object" && value !== null && typeof Reflect.get(value, "id") === "number"
    && Reflect.get(value, "kind") === "tool" && typeof Reflect.get(value, "name") === "string"

const argumentOf = (args: unknown, name: string): unknown =>
    typeof args === "object" && args !== null ? Reflect.get(args, name) : undefined

const isTokenMessage = (value: unknown): value is { readonly type: "token", readonly token?: string, readonly expires: number } =>
    typeof value === "object" && value !== null && Reflect.get(value, "type") === "token"
    && typeof Reflect.get(value, "expires") === "number"

const isAgentToken = (value: unknown): value is AgentToken =>
    typeof value === "object" && value !== null
    && typeof Reflect.get(value, "token") === "string" && typeof Reflect.get(value, "expires") === "number"

const readStorage = (key: string): Nullable<string> => {
    const result = tryCatch(() => localStorage.getItem(key))
    return result.status === "success" ? result.value : null
}

const writeStorage = (key: string, value: string): void => {tryCatch(() => localStorage.setItem(key, value))}

const ok = (text: string): AgentToolResult => ({text, isError: false})
const failure = (text: string): AgentToolResult => ({text, isError: true})

const describe = (vertex: Vertex): AgentObject =>
    ({type: vertex.box.name, uuid: UUID.toString(vertex.box.address.uuid)})

export class AgentConnection {
    static readonly LocalUrl = "ws://127.0.0.1:8790"
    static readonly ServerUrl = Browser.isLocalHost() ? "ws://127.0.0.1:8791/agent/studio" : "wss://live.opendaw.studio/agent/studio"
    static readonly ServerMcpUrl = Browser.isLocalHost() ? "http://127.0.0.1:8791/agent/mcp" : "https://live.opendaw.studio/agent/mcp"
    static readonly TokenKey = "agent-relay-token"
    static readonly ModeKey = "agent-relay-mode"
    static readonly RetryMillis = 2000
    static readonly IdleMillis = 120_000
    static readonly ReadingTitle = "The agent is reading the project."
    static readonly ChangingTitle = "The agent is changing the project."
    static readonly CancelledMessage = "The user cancelled. Stop and report what you did so far."

    readonly #service: StudioService
    readonly #state: DefaultObservableValue<AgentConnectionState>
    readonly #mode: DefaultObservableValue<AgentRelayMode>
    readonly #token: MutableObservableOption<AgentToken>

    #host: Option<ScriptHost> = Option.None
    #socket: Option<WebSocket> = Option.None
    #retry: Option<number> = Option.None
    #task: Option<{ readonly task: AgentTask, readonly dialog: Terminable }> = Option.None
    #idle: Option<number> = Option.None
    #cancelled: boolean = false
    #apiParts: Option<Promise<ReadonlyArray<string>>> = Option.None

    constructor(service: StudioService) {
        this.#service = service
        this.#state = new DefaultObservableValue<AgentConnectionState>("off")
        this.#mode = new DefaultObservableValue<AgentRelayMode>(readStorage(AgentConnection.ModeKey) === "local" ? "local" : "server")
        this.#token = new MutableObservableOption<AgentToken>()
        const stored = tryCatch(() => JSON.parse(readStorage(AgentConnection.TokenKey) ?? "null"))
        if (stored.status === "success" && isAgentToken(stored.value) && stored.value.expires > Date.now()) {
            this.#token.wrap(stored.value)
        }
    }

    get state(): ObservableValue<AgentConnectionState> {return this.#state}
    get mode(): ObservableValue<AgentRelayMode> {return this.#mode}
    get token(): ObservableOption<AgentToken> {return this.#token}

    connect(mode: AgentRelayMode): void {
        this.disconnect()
        this.#mode.setValue(mode)
        writeStorage(AgentConnection.ModeKey, mode)
        this.#state.setValue("waiting")
        this.#open()
    }

    renew(): void {
        if (this.#mode.getValue() !== "server") {return}
        this.#socket.ifSome(socket => {
            if (socket.readyState === WebSocket.OPEN) {socket.send(JSON.stringify({type: "renew"}))}
        })
    }

    disconnect(): void {
        this.#endTask()
        this.#cancelled = false
        this.#state.setValue("off")
        this.#retry.ifSome(handle => clearTimeout(handle))
        this.#retry = Option.None
        this.#socket.ifSome(socket => socket.close())
        this.#socket = Option.None
    }

    #open(): void {
        this.#retry = Option.None
        const server = this.#mode.getValue() === "server"
        const socket = new WebSocket(server ? AgentConnection.ServerUrl : AgentConnection.LocalUrl)
        this.#socket = Option.wrap(socket)
        const sendAgent = () =>
            socket.send(JSON.stringify({type: "agent", instructions: AgentTexts.Instructions, tools: AgentTexts.Tools}))
        socket.onopen = () => {
            if (server) {
                socket.send(JSON.stringify({type: "hello", token: this.#token.match({none: () => null, some: ({token}) => token})}))
            } else {
                this.#state.setValue("connected")
                sendAgent()
            }
        }
        socket.onmessage = async (event: MessageEvent) => {
            const request: unknown = JSON.parse(String(event.data))
            if (isTokenMessage(request)) {
                this.#storeToken(request.token, request.expires)
                if (this.#state.getValue() !== "connected") {
                    this.#state.setValue("connected")
                    sendAgent()
                }
                return
            }
            if (!isToolCall(request)) {return}
            const {text, isError} = await this.#callTool(request.name, request.arguments)
            socket.send(JSON.stringify({type: "tool-result", id: request.id, text, isError}))
        }
        socket.onclose = () => {
            if (this.#socket.unwrapOrNull() !== socket) {return}
            this.#socket = Option.None
            this.#endTask()
            this.#cancelled = false
            if (this.#state.getValue() === "off") {return}
            this.#state.setValue("waiting")
            this.#retry = Option.wrap(window.setTimeout(() => this.#open(), AgentConnection.RetryMillis))
        }
    }

    #storeToken(token: Optional<string>, expires: number): void {
        const value = isDefined(token) ? token : this.#token.match({none: () => null, some: current => current.token})
        if (!isDefined(value)) {return}
        const next: AgentToken = {token: value, expires}
        this.#token.wrap(next)
        writeStorage(AgentConnection.TokenKey, JSON.stringify(next))
    }

    async #callTool(name: string, args: unknown): Promise<AgentToolResult> {
        if (name !== "begin_task" && name !== "end_task" && !this.#cancelled && this.#task.isEmpty()) {
            this.#beginTask(AgentConnection.ReadingTitle)
        }
        switch (name) {
            case "get_api": {
                this.#countCall()
                const loaded = await Promises.tryCatch(this.#api())
                if (loaded.status === "rejected") {
                    this.#apiParts = Option.None
                    return failure(`The studio could not load the API: ${Errors.toString(loaded.error)}`)
                }
                const parts = loaded.value
                const part = argumentOf(args, "part")
                const text = typeof part === "number" ? parts.at(part - 1) : undefined
                return text === undefined ? failure(`There are ${parts.length} parts.`)
                    : ok(`Part ${part} of ${parts.length}\n\n${text}`)
            }
            case "run_script": {
                const code = argumentOf(args, "code")
                if (typeof code !== "string") {return failure("run_script needs code")}
                const {result, error} = await this.#runInTask(code)
                return error === null ? ok(result ?? "ok") : failure(error)
            }
            case "get_context":
                this.#countCall()
                return ok(JSON.stringify(this.#context(), null, 2))
            case "begin_task": {
                const title = argumentOf(args, "title")
                const text = typeof title === "string" ? title : AgentConnection.ChangingTitle
                this.#task.match({
                    none: () => {
                        this.#beginTask(text)
                        this.#countCall()
                    },
                    some: ({task}) => {
                        task.rename(text)
                        this.#touch()
                    }
                })
                return ok("ok")
            }
            case "end_task":
                this.#endTask()
                return ok("ok")
            default:
                return failure(`Unknown tool ${name}`)
        }
    }

    #beginTask(title: string): void {
        this.#endTask()
        this.#cancelled = false
        const task = new AgentTask(this.#service, title)
        this.#task = Option.wrap({task, dialog: AgentTaskDialog.show(task, () => this.#cancel())})
        this.#touch()
    }

    #endTask(): void {
        this.#idle.ifSome(handle => clearTimeout(handle))
        this.#idle = Option.None
        this.#task.ifSome(({task, dialog}) => {
            this.#task = Option.None
            dialog.terminate()
            task.finish()
        })
    }

    #cancel(): void {
        this.#endTask()
        this.#cancelled = true
    }

    #countCall(): void {
        this.#task.ifSome(({task}) => task.count())
        this.#touch()
    }

    #touch(): void {
        if (this.#task.isEmpty()) {return}
        this.#idle.ifSome(handle => clearTimeout(handle))
        this.#idle = Option.wrap(window.setTimeout(() => this.#endTask(), AgentConnection.IdleMillis))
    }

    async #runInTask(code: string): Promise<AgentRunResult> {
        if (this.#cancelled) {return {result: null, error: AgentConnection.CancelledMessage}}
        if (this.#task.isEmpty()) {this.#beginTask(AgentConnection.ChangingTitle)}
        this.#countCall()
        const outcome = await this.#run(code)
        this.#touch()
        return outcome
    }

    #scriptHost(): ScriptHost {
        if (this.#host.isEmpty()) {this.#host = Option.wrap(StudioScriptHost.create(this.#service))}
        return this.#host.unwrap()
    }

    async #run(code: string): Promise<AgentRunResult> {
        const {status, value, error} = await Promises.tryCatch(this.#scriptHost().evaluateScript(code, {
            sampleRate: this.#service.audioContext.sampleRate,
            baseFrequency: this.#service.optProject
                .map(project => project.rootBox.baseFrequency.getValue()).unwrapOrElse(440.0)
        }))
        return status === "rejected" ? {result: null, error: Errors.toString(error)} : {result: value, error: null}
    }

    #api(): Promise<ReadonlyArray<string>> {
        if (this.#apiParts.isEmpty()) {
            this.#apiParts = Option.wrap(Promise.all([
                import("@opendaw/studio-scripting/api.declaration?raw"),
                import("@opendaw/studio-scripting/library?raw")
            ]).then(modules => AgentTexts.apiParts(modules.map(module => module.default))))
        }
        return this.#apiParts.unwrap()
    }

    #context(): AgentContext {
        const playhead = this.#service.engine.position.getValue()
        return this.#service.optProject.match<AgentContext>({
            none: () => ({
                project: null, editingDevice: null, editingRegion: null, selection: [], playhead,
                loop: {enabled: false, from: 0, to: 0}
            }),
            some: ({userEditingManager, selection, timelineBox: {loopArea}}) => ({
                project: this.#service.profile.meta.name,
                editingDevice: userEditingManager.audioUnit.get().mapOr(describe, null),
                editingRegion: userEditingManager.timeline.get().mapOr(describe, null),
                selection: selection.selected().map(describe),
                playhead,
                loop: {enabled: loopArea.enabled.getValue(), from: loopArea.from.getValue(), to: loopArea.to.getValue()}
            })
        })
    }
}
