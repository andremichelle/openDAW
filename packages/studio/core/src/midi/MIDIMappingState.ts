import {Nullable, unitValue} from "@opendaw/lib-std"

export class MIDIMappingState {
    lastController: Nullable<unitValue> = null
    lastApplied: Nullable<unitValue> = null
    relativeValue: Nullable<unitValue> = null
    pickedUp: boolean = false
}
