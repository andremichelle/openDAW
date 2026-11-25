import {int, isDefined, UUID} from "@opendaw/lib-std"
import {AddressLayout, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import type {SampleLoadEvent} from "@opendaw/studio-core"

// The last update ops sent to the engine and its sample loads, for engine trap reports: box types, short box ids
// and field keys only, never values.
export class UpdateHistory {
    static readonly CAPACITY: int = 32

    readonly #names: Map<string, string> = new Map()
    readonly #entries: Array<string> = []

    #transaction: int = 0
    #startTime: number = performance.now()

    reset(): void {
        this.#names.clear()
        this.#transaction = 0
        this.#startTime = performance.now()
    }

    record(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
        const transaction = this.#transaction++
        const seconds = this.#seconds()
        tasks.forEach(task => {
            if (task.type === "new") {this.#names.set(UUID.toString(task.uuid), task.name as string)}
            if (transaction > 0) {this.#push(`#${transaction} ${seconds}s ${this.#describe(task)}`)}
            if (task.type === "delete") {this.#names.delete(UUID.toString(task.uuid))}
        })
        if (transaction === 0) {this.#push(`#0 ${seconds}s full dump of ${tasks.length} ops`)}
    }

    recordSample(event: SampleLoadEvent): void {
        const box = this.#name(event.uuid)
        const outcome = event.type === "delivered"
            ? `delivered ${event.numberOfFrames} frames, ${event.numberOfChannels} ch, ${event.sampleRate} Hz`
            : event.type
        this.#push(`sample ${this.#seconds()}s ${box} ${outcome}`)
    }

    entries(): ReadonlyArray<string> {return this.#entries}

    #seconds(): string {return ((performance.now() - this.#startTime) / 1000).toFixed(2)}

    #push(entry: string): void {
        this.#entries.push(entry)
        if (this.#entries.length > UpdateHistory.CAPACITY) {this.#entries.shift()}
    }

    #describe(task: UpdateTask<BoxIO.TypeMap>): string {
        switch (task.type) {
            case "new":
                return `new ${this.#name(task.uuid)}`
            case "delete":
                return `delete ${this.#name(task.uuid)}`
            case "update-primitive":
                return `primitive ${this.#address(task.address)} (${task.primitiveType})`
            case "update-bytes":
                return `bytes ${this.#address(task.address)} (${task.bytes.length} at ${task.offset})`
            case "update-pointer":
                return `pointer ${this.#address(task.address)} -> ${isDefined(task.target) ? this.#address(task.target) : "none"}`
        }
    }

    #name(uuid: UUID.Bytes): string {
        const id = UUID.toString(uuid)
        return `${this.#names.get(id) ?? "unknown box"}:${id.slice(0, 8)}`
    }

    #address([uuid, fields]: AddressLayout): string {
        return fields.length === 0 ? this.#name(uuid) : `${this.#name(uuid)}/${Array.from(fields).join("/")}`
    }
}
