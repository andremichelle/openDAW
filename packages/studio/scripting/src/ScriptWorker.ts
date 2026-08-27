import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {AudioData} from "@opendaw/lib-dsp"
import {ScriptExecutionContext, ScriptExecutionProtocol} from "./ScriptExecutionProtocol"
import {ScriptRunner} from "./ScriptRunner"
import {ScriptHostProtocol} from "./ScriptHostProtocol"
import {Sample} from "./Api"

const messenger: Messenger = Messenger.for(self)

const hostProtocol = Communicator.sender<ScriptHostProtocol>(messenger.channel("scripting-host"),
    dispatcher => new class implements ScriptHostProtocol {
        openProject(buffer: ArrayBufferLike, name?: string): void {
            dispatcher.dispatchAndForget(this.openProject, buffer, name)
        }
        hasProject(): Promise<boolean> {
            return dispatcher.dispatchAndReturn(this.hasProject)
        }
        fetchProject(): Promise<{ buffer: ArrayBuffer; name: string }> {
            return dispatcher.dispatchAndReturn(this.fetchProject)
        }
        showInfo(headline: string, message: string): Promise<void> {
            return dispatcher.dispatchAndReturn(this.showInfo, headline, message)
        }
        addSample(data: AudioData, name: string): Promise<Sample> {
            return dispatcher.dispatchAndReturn(this.addSample, data, name)
        }
        listSamples(): Promise<ReadonlyArray<Sample>> {
            return dispatcher.dispatchAndReturn(this.listSamples)
        }
    })

Communicator.executor(messenger.channel("scripting-execution"), new class implements ScriptExecutionProtocol {
    readonly #scriptExecutor = new ScriptRunner(hostProtocol)

    executeScript(script: string, context: ScriptExecutionContext): Promise<void> {
        return this.#scriptExecutor.run(script, context)
    }
})
