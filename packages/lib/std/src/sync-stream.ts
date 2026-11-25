import {ByteArrayInput, ByteArrayOutput} from "./data"
import {panic, Procedure, Provider} from "./lang"
import {Schema} from "./schema"

export namespace SyncStream {
    const enum State {READING, READ, WRITING, WRITTEN}

    export interface Writer {
        readonly tryWrite: Provider<boolean>
    }

    export interface Reader {
        readonly buffer: SharedArrayBuffer
        readonly tryRead: Provider<boolean>
    }

    export const writer = <T extends object>(io: Schema.IO<T>, buffer: SharedArrayBuffer, populate: Procedure<T>): Writer => {
        if (io.bytesTotal + 1 > buffer.byteLength) {return panic("Insufficient memory allocated.")}
        const array = new Uint8Array(buffer)
        const output = ByteArrayOutput.use(buffer, 1)
        Atomics.store(array, 0, State.READ)
        return {
            tryWrite: () => {
                if (Atomics.compareExchange(array, 0, State.READ, State.WRITING) === State.READ) {
                    populate(io.object)
                    output.position = 0
                    io.write(output)
                    Atomics.store(array, 0, State.WRITTEN)
                    return true
                }
                return false
            }
        }
    }

    export const reader = <T extends object>(io: Schema.IO<T>, procedure: Procedure<T>): Reader => {
        const buffer = new SharedArrayBuffer(io.bytesTotal + 1)
        const array = new Uint8Array(buffer)
        const input = new ByteArrayInput(buffer, 1)
        return {
            buffer,
            tryRead: () => {
                if (Atomics.compareExchange(array, 0, State.WRITTEN, State.READING) === State.WRITTEN) {
                    input.position = 0
                    io.read(input)
                    procedure(io.object)
                    Atomics.store(array, 0, State.READ)
                    return true
                }
                return false
            }
        }
    }
}