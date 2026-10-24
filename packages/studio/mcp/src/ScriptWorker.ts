import {format} from "node:util"
import {workerData} from "node:worker_threads"
import {Messenger} from "@opendaw/lib-runtime"
import {ScriptConnection} from "@opendaw/studio-scripting"

const messenger = Messenger.for(workerData)
const output = messenger.channel("output")
const print = (prefix: string) => (...values: Array<unknown>) => output.send(prefix + format(...values))
Object.assign(console, {log: print(""), info: print(""), warn: print("warning: "), error: print("error: ")})
ScriptConnection.worker(messenger)
