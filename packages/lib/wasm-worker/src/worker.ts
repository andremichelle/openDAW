import {WasmProtocol} from "./WasmProtocol"
import {WasmRuntime} from "./WasmRuntime"

new WasmRuntime({
    post: (message, transfer) => self.postMessage(message, {transfer}),
    listen: listener => self.addEventListener("message",
        (event: MessageEvent<WasmProtocol.ToWorker>) => listener(event.data))
})
self.addEventListener("messageerror", () => self.postMessage({type: "broken", reason: "a message could not be read"}))
