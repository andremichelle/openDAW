import {PointerTypes, PrimitiveField, PrimitiveValues} from "@opendaw/lib-box"
import {isDefined, Option, panic} from "@opendaw/lib-std"
import {Context} from "./Context"
import {Guard} from "./Guard"

export type AnyPrimitiveField = PrimitiveField<PrimitiveValues, PointerTypes>
export type FieldSpec = { readonly [key: string]: AnyPrimitiveField | FieldSpec | ReadonlyArray<AnyPrimitiveField | FieldSpec> }

export namespace Fields {
    const specs = new WeakMap<object, FieldSpec>()

    export const bind = <T extends object>(context: Context, target: T, spec: FieldSpec, prefix: string = ""): T => {
        specs.set(target, {...(specs.get(target) ?? {}), ...spec})
        Object.entries(spec).forEach(([key, entry]) => {
            const name = `${prefix}${key}`
            if (entry instanceof PrimitiveField) {
                accessor(context, target, key, name, entry)
            } else if (Array.isArray(entry)) {
                const array: Array<unknown> = []
                entry.forEach((element, index) => {
                    if (element instanceof PrimitiveField) {
                        accessor(context, array, String(index), `${name}.${index}`, element)
                    } else {
                        array.push(bind(context, {}, element as FieldSpec, `${name}.${index}.`))
                    }
                })
                Object.defineProperty(target, key, {enumerable: true, value: Object.freeze(array)})
            } else {
                Object.defineProperty(target, key, {
                    enumerable: true, value: bind(context, {}, entry as FieldSpec, `${name}.`)
                })
            }
        })
        return target
    }

    export const resolve = (target: object, path: string): Option<AnyPrimitiveField> => {
        const segments = path.split(".")
        const walk = (spec: FieldSpec | ReadonlyArray<AnyPrimitiveField | FieldSpec> | AnyPrimitiveField,
                      index: number): Option<AnyPrimitiveField> => {
            if (spec instanceof PrimitiveField) {
                return index === segments.length ? Option.wrap(spec) : Option.None
            }
            if (index === segments.length) {return Option.None}
            const segment = segments[index]
            if (Array.isArray(spec)) {
                const element = spec[Number(segment)]
                return isDefined(element) ? walk(element, index + 1) : Option.None
            }
            const entry = (spec as FieldSpec)[segment]
            return isDefined(entry) ? walk(entry, index + 1) : Option.None
        }
        const spec = specs.get(target)
        return isDefined(spec) ? walk(spec, 0) : Option.None
    }

    export const paths = (target: object): ReadonlyArray<string> => {
        const result: Array<string> = []
        const walk = (spec: FieldSpec | ReadonlyArray<AnyPrimitiveField | FieldSpec> | AnyPrimitiveField,
                      prefix: string): void => {
            if (spec instanceof PrimitiveField) {
                result.push(prefix)
            } else if (Array.isArray(spec)) {
                spec.forEach((element, index) => walk(element, `${prefix}.${index}`))
            } else {
                Object.entries(spec as FieldSpec)
                    .forEach(([key, entry]) => walk(entry, prefix.length === 0 ? key : `${prefix}.${key}`))
            }
        }
        const spec = specs.get(target)
        if (isDefined(spec)) {walk(spec, "")}
        return result
    }

    export const accessor = (context: Context, target: object, key: string, name: string, field: AnyPrimitiveField): void => {
        Object.defineProperty(target, key, {
            enumerable: true,
            get: () => attached(field, name).getValue(),
            set: (value: unknown) => context.edit(() => attached(field, name).setValue(Guard.field(field, value, name)))
        })
    }

    const attached = (field: AnyPrimitiveField, name: string): AnyPrimitiveField =>
        field.isAttached() ? field : panic(`${name}: ${field.box.name} has been removed`)
}
