import {Box, PointerField} from "@opendaw/lib-box"
import {asInstanceOf, Class, isAbsent, isDefined, isNotNull, Nullable, Optional, panic, UUID} from "@opendaw/lib-std"
import {Context} from "./Context"
import {AnyPrimitiveField, Fields, FieldSpec} from "./Fields"
import {Guard} from "./Guard"

export abstract class Facade<B extends Box = Box> {
    readonly #context: Context
    readonly #box: B

    protected constructor(context: Context, box: B) {
        this.#context = context
        this.#box = box
    }

    get uuid(): string {return UUID.toString(this.#box.address.uuid)}
    get box(): B {
        if (!this.#box.isAttached()) {return panic(`${this.constructor.name} (${this.uuid}) has been removed`)}
        return this.#box
    }
    get context(): Context {return this.#context}
    get attached(): boolean {return this.#box.isAttached()}

    remove(): void {this.#context.edit(() => this.box.delete())}

    protected bind(spec: FieldSpec): void {Fields.bind(this.#context, this, spec)}

    toString(): string {return `${this.constructor.name}(${this.uuid})`}
}

export namespace Props {
    export const apply = <T extends object>(target: T, props: unknown, name: string = "props"): T => {
        if (isAbsent(props)) {return target}
        if (typeof props !== "object") {return panic(new TypeError(`${name}: expected an object, got ${Guard.describe(props)}`))}
        Object.entries(props as Record<string, unknown>).forEach(([key, value]) => {
            if (isAbsent(value)) {return}
            const descriptor = findDescriptor(target, key)
            if (!isDefined(descriptor)) {return panic(new TypeError(`${name}.${key}: unknown property`))}
            if (isDefined(descriptor.set)) {
                (target as Record<string, unknown>)[key] = value
                return
            }
            const current = (target as Record<string, unknown>)[key]
            if (typeof current === "object" && isNotNull(current) && typeof value === "object" && isNotNull(value)) {
                if (Array.isArray(current)) {
                    if (!Array.isArray(value)) {return panic(new TypeError(`${name}.${key}: expected an array`))}
                    value.forEach((element, index) => {
                        if (index >= current.length) {return panic(new RangeError(`${name}.${key}: index ${index} out of range`))}
                        if (typeof current[index] === "object") {
                            apply(current[index] as object, element, `${name}.${key}.${index}`)
                        } else {
                            current[index] = element
                        }
                    })
                } else {
                    apply(current, value, `${name}.${key}`)
                }
                return
            }
            return panic(new TypeError(`${name}.${key}: property is read-only`))
        })
        return target
    }

    export const without = (props: unknown, ...keys: ReadonlyArray<string>): Record<string, unknown> => {
        if (isAbsent(props)) {return {}}
        if (typeof props !== "object") {return panic(new TypeError(`props: expected an object, got ${Guard.describe(props)}`))}
        return Object.fromEntries(Object.entries(props as Record<string, unknown>).filter(([key]) => !keys.includes(key)))
    }

    const findDescriptor = (target: object, key: string): Optional<PropertyDescriptor> => {
        let current: Nullable<object> = target
        while (isNotNull(current) && current !== Object.prototype) {
            const descriptor = Object.getOwnPropertyDescriptor(current, key)
            if (isDefined(descriptor)) {return descriptor}
            current = Object.getPrototypeOf(current)
        }
        return undefined
    }
}

export namespace Accessors {
    export const pointerBox = <B extends Box>(pointer: PointerField, type: Class<B>): Nullable<B> =>
        pointer.targetVertex.mapOr(vertex => asInstanceOf(vertex.box, type), null)
}

export namespace Parameters {
    export const resolve = (target: object, path: string): AnyPrimitiveField =>
        Fields.resolve(target, path)
            .unwrapOrElse(() => panic(new RangeError(`'${path}' is not a parameter of ${describe(target)}. ` +
                `Available: ${Fields.paths(target).join(", ")}`)))

    export const pathOf = (target: object, field: AnyPrimitiveField): Nullable<string> =>
        Fields.paths(target).find(path => Fields.resolve(target, path).contains(field)) ?? null

    const describe = (target: object): string => target.constructor.name
}
