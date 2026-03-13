import {Procedure, Subscription} from "@opendaw/lib-std"

export interface CodeEditorHandler {
    readonly name: string

    compile(code: string): Promise<void>
    subscribeErrors(observer: Procedure<string>): Subscription
}
