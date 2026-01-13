import {Terminable, Terminator} from "@moises-ai/lib-std"
import {BoxEditing} from "@moises-ai/lib-box"
import {UserInterfaceBox} from "@moises-ai/studio-boxes"
import {UserEditing} from "./UserEditing"

export class UserEditingManager implements Terminable {
    readonly #terminator: Terminator
    readonly #modularSystem: UserEditing
    readonly #timeline: UserEditing
    readonly #audioUnit: UserEditing

    constructor(editing: BoxEditing) {
        this.#terminator = new Terminator()
        this.#modularSystem = this.#terminator.own(new UserEditing(editing))
        this.#timeline = this.#terminator.own(new UserEditing(editing))
        this.#audioUnit = this.#terminator.own(new UserEditing(editing))
    }

    follow(userInterfaceBox: UserInterfaceBox): void {
        this.#modularSystem.follow(userInterfaceBox.editingModularSystem)
        this.#timeline.follow(userInterfaceBox.editingTimelineRegion)
        this.#audioUnit.follow(userInterfaceBox.editingDeviceChain)
    }

    get modularSystem(): UserEditing {return this.#modularSystem}
    get timeline(): UserEditing {return this.#timeline}
    get audioUnit(): UserEditing {return this.#audioUnit}

    terminate(): void {this.#terminator.terminate()}
}