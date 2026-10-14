/// <reference lib="webworker" />
import {runMuScriptor} from "./Runtime"
import {MuScriptorWorkerRequest, MuScriptorWorkerResponse} from "./types"

const post = (message: MuScriptorWorkerResponse): void => self.postMessage(message)
self.addEventListener("message", async (event: MessageEvent<MuScriptorWorkerRequest>) => {
    try {
        const notes = await runMuScriptor(event.data.input, event.data.assets,
            value => post({kind: "progress", value}))
        post({kind: "result", notes})
    } catch (error) {
        post({kind: "error", message: error instanceof Error ? error.message : String(error)})
    }
})
