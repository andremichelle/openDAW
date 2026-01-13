import {assert, ByteArrayInput, ByteArrayOutput, Hash} from "@moises-ai/lib-std"
import {Update} from "@moises-ai/lib-box"
import {Project} from "../project/Project"

export const enum CommitType { Init, Open, Updates, NewVersion }

export class Commit {
    static readonly VERSION = 1 // For devs: walk your way to dynamic versioning from here

    static readonly #NO_PAYLOAD = new Uint8Array(1).buffer
    static readonly #EMPTY_HASH = new Uint8Array(32).buffer

    static createFirst(project: Project): Promise<Commit> {
        const payload = project.toArrayBuffer() as ArrayBuffer
        return this.#create(CommitType.Init, Commit.#EMPTY_HASH, payload)
    }

    static createOpen(prevHash: ArrayBuffer): Promise<Commit> {
        return this.#create(CommitType.Open, prevHash, Commit.#NO_PAYLOAD)
    }

    static async createUpdate(prevHash: ArrayBuffer, updates: ReadonlyArray<Update>): Promise<Commit> {
        const output = ByteArrayOutput.create()
        output.writeInt(updates.length)
        updates.forEach(update => update.write(output))
        return this.#create(CommitType.Updates, prevHash, output.toArrayBuffer() as ArrayBuffer)
    }

    static async #create(type: CommitType, prevHash: ArrayBuffer, payload: ArrayBuffer): Promise<Commit> {
        const date = Date.now()
        const output = ByteArrayOutput.create()
        const data = output.toArrayBuffer() as ArrayBuffer
        const thisHash = await Hash.fromBuffers(data, prevHash, new Float64Array([date]).buffer)
        return new Commit(type, prevHash, thisHash, payload, date)
    }

    static deserialize(input: ByteArrayInput): Commit {
        const type = input.readInt() as CommitType
        assert(type === CommitType.Init
            || type === CommitType.Open
            || type === CommitType.Updates
            || type === CommitType.NewVersion,
            `Unknown commit type "${type}"`)
        const version = input.readInt()
        assert(version === Commit.VERSION, "version mismatch")
        const prevHash = new Int8Array(32)
        input.readBytes(prevHash)
        const thisHash = new Int8Array(32)
        input.readBytes(thisHash)
        const data = new Int8Array(input.readInt())
        input.readBytes(data)
        const date = input.readDouble()
        return new Commit(type, prevHash.buffer, thisHash.buffer, data.buffer, date)
    }

    private constructor(readonly type: CommitType,
                        readonly prevHash: ArrayBuffer,
                        readonly thisHash: ArrayBuffer,
                        readonly payload: ArrayBuffer,
                        readonly date: number) {}

    serialize(): ArrayBuffer {
        const output = ByteArrayOutput.create()
        output.writeInt(this.type)
        output.writeInt(Commit.VERSION)
        output.writeBytes(new Int8Array(this.prevHash))
        output.writeBytes(new Int8Array(this.thisHash))
        output.writeInt(this.payload.byteLength)
        output.writeBytes(new Int8Array(this.payload))
        output.writeDouble(this.date)
        return output.toArrayBuffer() as ArrayBuffer
    }

    toString(): string {
        return `{prevHash: ${Hash.toString(this.prevHash)}, thisHash: ${Hash.toString(this.thisHash)}, payload: ${this.payload.byteLength}bytes}`
    }
}