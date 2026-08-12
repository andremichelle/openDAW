import {Option, unitValue} from "@opendaw/lib-std"
import {NoteEvent, ppqn} from "@opendaw/lib-dsp"

export class NoteDrawDefaults {
    static #duration: Option<ppqn> = Option.None
    static #velocity: unitValue = 100.0 / 127.0

    static remember({duration, velocity}: NoteEvent): void {
        NoteDrawDefaults.#duration = Option.wrap(duration)
        NoteDrawDefaults.#velocity = velocity
    }

    static get velocity(): unitValue {return NoteDrawDefaults.#velocity}

    static durationOr(fallback: ppqn): ppqn {return NoteDrawDefaults.#duration.unwrapOrElse(fallback)}
}