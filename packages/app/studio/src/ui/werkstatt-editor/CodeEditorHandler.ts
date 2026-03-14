import {MutableObservableValue, Procedure, Subscription, UUID} from "@opendaw/lib-std"

export interface CodeEditorHandler {
    readonly uuid: UUID.Bytes
    readonly name: MutableObservableValue<string>

    compile(code: string): Promise<void>
    subscribeErrors(observer: Procedure<string>): Subscription
}
