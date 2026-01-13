import {FieldKey, Fields} from "./field"
import {assert, ByteArrayInput, ByteArrayOutput, DataInput, DataOutput, isUndefined, tryCatch} from "@moises-ai/lib-std"

export namespace Serializer {
    const MAGIC_HEADER = 0x464c4453
    export const writeFields = <FIELDS extends Fields>(output: DataOutput, fields: FIELDS) => {
        const entries = Object.entries(fields).filter(([_, field]) => !field.deprecated)
        output.writeInt(MAGIC_HEADER)
        output.writeShort(entries.length)
        entries.forEach(([key, field]) => {
            const bytes = ByteArrayOutput.create()
            field.write(bytes)
            const buffer = new Int8Array(bytes.toArrayBuffer())
            output.writeShort(Number(key))
            output.writeInt(buffer.length)
            output.writeBytes(buffer)
        })
    }

    export const readFields = <FIELDS extends Fields>(input: DataInput, fields: FIELDS) => {
        assert(input.readInt() === MAGIC_HEADER, "Serializer header is corrupt")
        const numFields = input.readShort()
        for (let i = 0; i < numFields; i++) {
            const key: FieldKey = input.readShort()
            if (isUndefined(fields[key])) {continue}
            const byteLength = input.readInt()
            const bytes = new Int8Array(byteLength)
            input.readBytes(bytes)
            const {status, error} = tryCatch(() => fields[key]?.read(new ByteArrayInput(bytes.buffer)))
            if (status === "failure") {
                console.warn(fields, error)
            }
        }
    }
}