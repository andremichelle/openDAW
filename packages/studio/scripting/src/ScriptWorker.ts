import {Communicator, Messenger} from "@moises-ai/lib-runtime"

import {ScriptExecutionContext, ScriptExecutionProtocol} from "./ScriptExecutionProtocol"
import {ScriptRunner} from "./ScriptRunner"
import {ScriptHostProtocol} from "./ScriptHostProtocol"
import {Sample} from "@moises-ai/studio-adapters"
import {AudioData} from "@moises-ai/lib-dsp"

const messenger: Messenger = Messenger.for(self)

const hostProtocol = Communicator.sender<ScriptHostProtocol>(messenger.channel("scripting-host"),
    dispatcher => new class implements ScriptHostProtocol {
        openProject(buffer: ArrayBufferLike, name?: string): void {
            dispatcher.dispatchAndForget(this.openProject, buffer, name)
        }
        fetchProject(): Promise<{ buffer: ArrayBuffer; name: string }> {
            return dispatcher.dispatchAndReturn(this.fetchProject)
        }
        addSample(data: AudioData, name: string): Promise<Sample> {
            return dispatcher.dispatchAndReturn(this.addSample, data, name)
        }
    })

Communicator.executor(messenger.channel("scripting-execution"), new class implements ScriptExecutionProtocol {
    readonly #scriptExecutor = new ScriptRunner(hostProtocol)

    // TODO We might return information about the script execution, e.g. warnings
    executeScript(script: string, context: ScriptExecutionContext): Promise<void> {
        return this.#scriptExecutor.run(script, context)
    }
})