import {DefaultObservableValue, Errors, Nullable, ObservableValue, Option, Terminable, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Vertex} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {ScriptHost} from "@opendaw/studio-scripting"
import {StudioService} from "@/service/StudioService"
import {StudioScriptHost} from "@/script/StudioScriptHost"
import {AgentTask} from "@/script/AgentTask"
import {AgentTaskDialog} from "@/script/AgentTaskDialog"

export type AgentConnectionState = "off" | "waiting" | "connected"

type AgentRequest =
    | { readonly id: number, readonly kind: "run", readonly code: string }
    | { readonly id: number, readonly kind: "context" | "end" | "called" }
    | { readonly id: number, readonly kind: "begin", readonly title: string }

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

const isAgentRequest = (value: unknown): value is AgentRequest => {
    if (typeof value !== "object" || value === null || typeof Reflect.get(value, "id") !== "number") {return false}
    const kind: unknown = Reflect.get(value, "kind")
    return kind === "context" || kind === "end" || kind === "called"
        || (kind === "run" && typeof Reflect.get(value, "code") === "string")
        || (kind === "begin" && typeof Reflect.get(value, "title") === "string")
}

const describe = (vertex: Vertex): AgentObject =>
    ({type: vertex.box.name, uuid: UUID.toString(vertex.box.address.uuid)})

export class AgentConnection {
    static readonly DefaultUrl = "ws://127.0.0.1:8790"
    static readonly RetryMillis = 2000
    static readonly IdleMillis = 120_000
    static readonly CancelledMessage = "The user cancelled. Stop and report what you did so far."

    readonly #service: StudioService
    readonly #state: DefaultObservableValue<AgentConnectionState>

    #host: Option<ScriptHost> = Option.None
    #url: string = AgentConnection.DefaultUrl
    #socket: Option<WebSocket> = Option.None
    #retry: Option<number> = Option.None
    #task: Option<{ readonly task: AgentTask, readonly dialog: Terminable }> = Option.None
    #idle: Option<number> = Option.None
    #cancelled: boolean = false

    constructor(service: StudioService) {
        this.#service = service
        this.#state = new DefaultObservableValue<AgentConnectionState>("off")
    }

    get state(): ObservableValue<AgentConnectionState> {return this.#state}
    get url(): string {return this.#url}

    connect(url: string): void {
        this.disconnect()
        this.#url = url
        this.#state.setValue("waiting")
        this.#open()
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
        const socket = new WebSocket(this.#url)
        this.#socket = Option.wrap(socket)
        socket.onopen = async () => {
            this.#state.setValue("connected")
            socket.send(JSON.stringify({type: "api", texts: await this.#api()}))
        }
        socket.onmessage = async (event: MessageEvent) => {
            const request: unknown = JSON.parse(String(event.data))
            if (!isAgentRequest(request)) {return}
            switch (request.kind) {
                case "begin":
                    this.#beginTask(request.title)
                    socket.send(JSON.stringify({type: "result", id: request.id, result: null, error: null}))
                    return
                case "end":
                    this.#endTask()
                    socket.send(JSON.stringify({type: "result", id: request.id, result: null, error: null}))
                    return
                case "called":
                    this.#countCall()
                    return
                case "context":
                    this.#countCall()
                    socket.send(JSON.stringify({type: "context", id: request.id, context: this.#context()}))
                    return
                case "run":
                    socket.send(JSON.stringify({type: "result", id: request.id, ...await this.#runInTask(request.code)}))
            }
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
        if (this.#task.isEmpty()) {this.#beginTask("The agent is changing the project.")}
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

    async #api(): Promise<ReadonlyArray<string>> {
        const modules = await Promise.all([
            import("@opendaw/studio-scripting/api.declaration?raw"),
            import("@opendaw/studio-scripting/library?raw")
        ])
        return modules.map(module => module.default)
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
