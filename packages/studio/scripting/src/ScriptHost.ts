import {Errors, Nullable, Option, RuntimeNotification, RuntimeNotifier} from "@opendaw/lib-std"
import {Communicator, Messenger, Promises} from "@opendaw/lib-runtime"
import {ScriptExecutionContext, ScriptExecutionProtocol} from "./ScriptExecutionProtocol"
import {DialogRequest, DialogValue, ScriptHostProtocol} from "./ScriptHostProtocol"

export class ScriptHost implements ScriptExecutionProtocol {
    readonly #executor: ScriptExecutionProtocol

    #progress: Option<RuntimeNotification.ProgressUpdater> = Option.None
    #executing: boolean = false

    constructor(host: ScriptHostProtocol, scriptURL: string) {
        const messenger = Messenger.for(new Worker(scriptURL, {type: "module"}))
        Communicator.executor<ScriptHostProtocol>(messenger.channel("scripting-host"), {
            openProject: (buffer, name) => host.openProject(buffer, name),
            applyUpdates: (updates, checksum) => host.applyUpdates(updates, checksum),
            hasProject: () => host.hasProject(),
            fetchProject: () => host.fetchProject(),
            showInfo: (headline, message) => host.showInfo(headline, message),
            showDialog: (request) => this.#showDialog(host, request),
            addSample: (data, name) => host.addSample(data, name),
            listSamples: () => host.listSamples(),
            renderMixdown: (buffer, options) => host.renderMixdown(buffer, options),
            saveFile: (buffer, fileName, mimeType) => host.saveFile(buffer, fileName, mimeType)
        })
        this.#executor = Communicator.sender<ScriptExecutionProtocol>(messenger.channel("scripting-execution"),
            dispatcher => new class implements ScriptExecutionProtocol {
                executeScript(script: string, context: ScriptExecutionContext): Promise<void> {
                    return dispatcher.dispatchAndReturn(this.executeScript, script, context)
                }
            })
    }

    async executeScript(script: string, context: ScriptExecutionContext): Promise<void> {
        this.#executing = true
        this.#showProgress()
        const {status, error} = await Promises.tryCatch(this.#executor.executeScript(script, context))
        this.#executing = false
        this.#hideProgress()
        if (status === "rejected" && !Errors.isAbort(error)) {
            console.warn(error)
            RuntimeNotifier.notify({message: "The script caused an error.", icon: "Warning"})
        }
    }

    async #showDialog(host: ScriptHostProtocol, request: DialogRequest): Promise<Nullable<ReadonlyArray<DialogValue>>> {
        this.#hideProgress()
        const {status, value, error} = await Promises.tryCatch(host.showDialog(request))
        if (this.#executing) {this.#showProgress()}
        return status === "rejected" ? Promise.reject(error) : value
    }

    #showProgress(): void {
        this.#hideProgress()
        this.#progress = Option.wrap(RuntimeNotifier.progress({headline: "Executing Script..."}))
    }

    #hideProgress(): void {
        this.#progress.ifSome(progress => progress.terminate())
        this.#progress = Option.None
    }
}
