import {Editing, Terminable, Terminator} from "@opendaw/lib-std"
import {UserInterfaceBox} from "@opendaw/studio-boxes"
import {UserEditing} from "./UserEditing"

export class UserEditingManager implements Terminable {
    readonly #terminator: Terminator
    readonly #modularSystem: UserEditing
    readonly #timeline: UserEditing
    readonly #audioUnit: UserEditing

    constructor(editing: Editing) {
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