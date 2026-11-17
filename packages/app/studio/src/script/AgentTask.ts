import {DefaultObservableValue, int, isInstanceOf, ObservableValue, Option} from "@opendaw/lib-std"
import {BoxEditing, EditingCheckpoint} from "@opendaw/lib-box"
import {StudioService} from "@/service/StudioService"

export class AgentTask {
    readonly startTime: number

    readonly #title: DefaultObservableValue<string>

    readonly #calls: DefaultObservableValue<int>
    readonly #checkpoint: Option<EditingCheckpoint>

    constructor(service: StudioService, title: string) {
        this.#title = new DefaultObservableValue<string>(title)
        this.startTime = performance.now()
        this.#calls = new DefaultObservableValue<int>(0)
        this.#checkpoint = service.optProject.flatMap(({editing}) =>
            isInstanceOf(editing, BoxEditing) ? Option.wrap(editing.checkpoint()) : Option.None)
    }

    get title(): ObservableValue<string> {return this.#title}
    get calls(): ObservableValue<int> {return this.#calls}

    rename(title: string): void {this.#title.setValue(title)}

    count(): void {this.#calls.setValue(this.#calls.getValue() + 1)}

    finish(): void {this.#checkpoint.ifSome(checkpoint => checkpoint.commit())}
}
