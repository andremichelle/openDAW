import {RuntimeNotifier} from "@opendaw/lib-std"
import {Communicator, Messenger, Promises} from "@opendaw/lib-runtime"
import {ScriptExecutionContext, ScriptExecutionProtocol} from "./ScriptExecutionProtocol"
import {ScriptHostProtocol} from "./ScriptHostProtocol"

export class ScriptHost implements ScriptExecutionProtocol {
    readonly #executor: ScriptExecutionProtocol

    constructor(host: ScriptHostProtocol, scriptURL: string) {
        const messenger = Messenger.for(new Worker(scriptURL, {type: "module"}))
        Communicator.executor<ScriptHostProtocol>(messenger.channel("scripting-host"), host)
        this.#executor = Communicator.sender<ScriptExecutionProtocol>(messenger.channel("scripting-execution"),
            dispatcher => new class implements ScriptExecutionProtocol {
                executeScript(script: string, context: ScriptExecutionContext): Promise<void> {
                    return dispatcher.dispatchAndReturn(this.executeScript, script, context)
                }
            })
    }

    async executeScript(script: string, context: ScriptExecutionContext): Promise<void> {
        const progressUpdater = RuntimeNotifier.progress({headline: "Executing Script..."})
        const {status, error} = await Promises.tryCatch(this.#executor.executeScript(script, context))
        progressUpdater.terminate()
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "The script caused an error.", icon: "Warning"})
        }
    }
}