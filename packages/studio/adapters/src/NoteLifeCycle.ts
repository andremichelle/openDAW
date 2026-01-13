import {byte, Procedure, Terminable, unitValue, UUID} from "@moises-ai/lib-std"
import {NoteSignal} from "./NoteSignal"

export namespace NoteLifeCycle {
    export const start = (send: Procedure<NoteSignal>, uuid: UUID.Bytes, pitch: byte, velocity: unitValue = 1.0): Terminable => {
        let playing = true
        send(NoteSignal.on(uuid, pitch, velocity))
        return {
            terminate: () => {
                if (playing) {
                    send(NoteSignal.off(uuid, pitch))
                    playing = false
                }
            }
        }
    }
}