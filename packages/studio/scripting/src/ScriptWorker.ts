import {Messenger} from "@opendaw/lib-runtime"
import {ScriptConnection} from "./ScriptConnection"

ScriptConnection.worker(Messenger.for(self))
