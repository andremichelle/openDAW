import {Lazy, panic} from "@opendaw/lib-std"
import {Field} from "./Field"

export type PrimitiveType = "float32" | "int32" | "boolean" | "string" | "bytes"

export type PrimitiveValue<T extends PrimitiveType> =
    T extends "float32" ? number :
        T extends "int32" ? number :
            T extends "boolean" ? boolean :
                T extends "string" ? string :
                    T extends "bytes" ? Int8Array :
                        never

export interface ParameterMetadata {
    readonly unit?: string
    readonly range?: readonly [number, number]
}

export class Parameter<T extends PrimitiveType> {
    readonly #parent: Field
    readonly #fieldKey: number
    readonly #type: T
    readonly #metadata: Readonly<ParameterMetadata>

    #value: PrimitiveValue<T>

    constructor(parent: Field,
                fieldKey: number,
                type: T,
                value: PrimitiveValue<T>,
                metadata?: ParameterMetadata) {
        this.#parent = parent
        this.#fieldKey = fieldKey
        this.#type = type
        this.#value = value
        this.#metadata = Object.freeze(metadata ?? {})
    }

    get(): PrimitiveValue<T> {return this.#value}

    set(value: PrimitiveValue<T>): void {
        switch (this.#type) {
            case "int32":
                if (typeof value !== "number") {
                    panic(`Expected number for int32, got ${typeof value}`)
                }
                value = Math.floor(value) as PrimitiveValue<T>
                break
            case "float32":
                if (typeof value !== "number") {
                    panic(`Expected number for float32, got ${typeof value}`)
                }
                if (isNaN(value)) {panic(`Invalid float32 value: ${value}`)}
                break
            case "boolean":
                if (typeof value !== "boolean") {panic(`Expected boolean, got ${typeof value}`)}
                break
            case "string":
                if (typeof value !== "string") {panic(`Expected string, got ${typeof value}`)}
                break
            case "bytes":
                if (!(value instanceof Int8Array)) {panic(`Expected Int8Array, got ${typeof value}`)}
                break
        }
        if (this.#metadata.range && typeof value === "number") {
            const [min, max] = this.#metadata.range
            value = Math.max(min, Math.min(max, value)) as PrimitiveValue<T>
        }
        this.#value = value
    }

    get metadata(): Readonly<ParameterMetadata> {return this.#metadata}

    @Lazy
    get path(): number[] {
        return [...this.#parent.path, this.#fieldKey]
    }
}