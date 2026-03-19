import {MutableObservableValue, Procedure, Subscription, UUID} from "@moises-ai/lib-std"

export interface CodeEditorHandler {
    readonly uuid: UUID.Bytes
    readonly name: MutableObservableValue<string>

    compile(code: string): Promise<void>
    subscribeErrors(observer: Procedure<string>): Subscription
    subscribeCode(observer: Procedure<string>): Subscription
}
