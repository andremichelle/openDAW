import {Errors, RuntimeNotifier} from "@opendaw/lib-std"
import {Messenger, Promises} from "@opendaw/lib-runtime"
import {ScriptExecutionContext, ScriptExecutionProtocol} from "./ScriptExecutionProtocol"
import {ScriptHostProtocol} from "./ScriptHostProtocol"
import {ScriptConnection} from "./ScriptConnection"

export class ScriptHost implements ScriptExecutionProtocol {
    readonly #executor: ScriptExecutionProtocol

    constructor(host: ScriptHostProtocol, scriptURL: string) {
        this.#executor = ScriptConnection.host(Messenger.for(new Worker(scriptURL, {type: "module"})), host)
    }

    async executeScript(script: string, context: ScriptExecutionContext): Promise<void> {
        const progressUpdater = RuntimeNotifier.progress({headline: "Executing Script..."})
        const {status, error} = await Promises.tryCatch(this.#executor.executeScript(script, context))
        progressUpdater.terminate()
        if (status === "rejected" && !Errors.isAbort(error)) {
            console.warn(error)
            RuntimeNotifier.notify({message: "The script caused an error.", icon: "Warning"})
        }
    }
}