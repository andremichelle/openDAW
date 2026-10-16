import {Option, panic} from "@opendaw/lib-std"
import {OpfsProtocol} from "@opendaw/lib-fusion"
import type {ModelDescriptor} from "./Task"

export interface InferenceConfig {
    readonly opfs: OpfsProtocol
    // a host that keeps the models itself (the desktop app) hands them out here, OPFS and the network are skipped
    readonly modelSource?: (taskKey: string, model: ModelDescriptor) => Promise<Option<Uint8Array>>
    readonly modelHosted?: (taskKey: string, model: ModelDescriptor) => Promise<boolean>
}

let installed: Option<InferenceConfig> = Option.None

export const installInferenceConfig = (config: InferenceConfig): void => {
    installed = Option.wrap(config)
}

export const requireInferenceConfig = (): InferenceConfig =>
    installed.match({
        none: () => panic("Inference is not installed. Call Inference.install({opfs}) at startup."),
        some: config => config
    })
