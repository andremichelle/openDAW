import {assert, Class, int, isDefined, Maybe, Nullable, Optional, panic, Provider, tryCatch, WeakMaps} from "@opendaw/lib-std"
import {XmlNode} from "./XmlNode"
import {XmlReader} from "./XmlReader"
import {XmlWriter} from "./XmlWriter"

export namespace Xml {
    export const Declaration = XmlWriter.Declaration

    export interface AttributeValidator<T> {
        required: boolean
        parse(value: string | T): T
        format?(value: T): string
    }

    export interface Codec<T> extends AttributeValidator<T> {
        format(value: T): string
    }

    export const codec = <T>(required: boolean,
                             parse: (value: string) => T,
                             format: (value: T) => string): Codec<T> => ({
        required,
        parse: (value: string | T): T => typeof value === "string" ? parse(value) : value,
        format
    })

    const DoublePattern = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

    export const parseDouble = (value: string): number => {
        const trimmed = value.trim()
        if (trimmed === "INF" || trimmed === "+INF") {return Number.POSITIVE_INFINITY}
        if (trimmed === "-INF") {return Number.NEGATIVE_INFINITY}
        if (trimmed === "NaN") {return Number.NaN}
        return DoublePattern.test(trimmed) ? Number(trimmed) : panic(`'${value}' is not a number`)
    }

    export const formatDouble = (value: number): string => {
        if (typeof value !== "number") {return panic(`'${value}' is not a number`)}
        if (Number.isNaN(value)) {return "NaN"}
        if (value === Number.POSITIVE_INFINITY) {return "INF"}
        if (value === Number.NEGATIVE_INFINITY) {return "-INF"}
        return String(value)
    }

    export const parseInt32 = (value: string): int => {
        const trimmed = value.trim()
        const number = /^[+-]?\d+(\.0*)?$/.test(trimmed) ? Number(trimmed) : Number.NaN
        return number >= -0x80000000 && number <= 0x7FFFFFFF ? number : panic(`'${value}' is not an int`)
    }

    export const formatInt32 = (value: int): string =>
        Number.isInteger(value) && value >= -0x80000000 && value <= 0x7FFFFFFF
            ? String(value) : panic(`'${value}' is not an int`)

    export const parseBoolean = (value: string): boolean => {
        const trimmed = value.trim().toLowerCase()
        if (trimmed === "true" || trimmed === "1") {return true}
        if (trimmed === "false" || trimmed === "0") {return false}
        return panic(`'${value}' is not a boolean`)
    }

    const formatBoolean = (value: boolean): string =>
        typeof value === "boolean" ? String(value) : panic(`'${value}' is not a boolean`)

    const formatString = (value: string): string => {
        const type = typeof value
        return type === "string" || type === "number" || type === "boolean"
            ? String(value) : panic(`'${value}' is not a string`)
    }

    export const StringRequired: Codec<string> = codec(true, value => value, formatString)
    export const StringOptional: Codec<string> = codec(false, value => value, formatString)
    export const BoolRequired: Codec<boolean> = codec(true, parseBoolean, formatBoolean)
    export const BoolOptional: Codec<boolean> = codec(false, parseBoolean, formatBoolean)
    export const NumberRequired: Codec<number> = codec(true, parseDouble, formatDouble)
    export const NumberOptional: Codec<number> = codec(false, parseDouble, formatDouble)
    export const IntRequired: Codec<int> = codec(true, parseInt32, formatInt32)
    export const IntOptional: Codec<int> = codec(false, parseInt32, formatInt32)

    export const Enum = <E extends string>(values: Readonly<Record<string, E>>, required: boolean): Codec<E> => {
        const accepted: ReadonlySet<string> = new Set(Object.values(values))
        const check = (value: string): E => accepted.has(value)
            ? value as E : panic(`'${value}' is not one of ${Array.from(accepted).join(", ")}`)
        return codec(required, value => check(value.trim()), check)
    }

    export const List = <T>(item: Codec<T>, required: boolean): Codec<ReadonlyArray<T>> => codec(required,
        value => Object.freeze(value.split(/\s+/).filter(entry => entry.length > 0).map(entry => item.parse(entry))),
        values => Array.isArray(values)
            ? values.map(value => item.format(value)).join(" ") : panic(`'${values}' is not a list`))

    type AttributeMeta = {
        readonly type: "attribute", readonly key: PropertyKey, readonly name: string,
        readonly codec: AttributeValidator<unknown>
    }
    type TextMeta = { readonly type: "text", readonly key: PropertyKey, readonly name: string, readonly required: boolean }
    type ElementMeta = {
        readonly type: "element", readonly key: PropertyKey, readonly name: Nullable<string>,
        readonly wrapper: Nullable<string>, readonly classes: Provider<ReadonlyArray<Class>>,
        readonly list: boolean, readonly required: boolean
    }
    export type Meta = AttributeMeta | TextMeta | ElementMeta
    export type MetaMap = ReadonlyMap<PropertyKey, Meta>

    export interface ElementOptions {
        readonly name?: string
        readonly wrapper?: string
        readonly required?: boolean
    }

    export interface ReadResult<T> {
        readonly value: T
        readonly issues: ReadonlyArray<string>
    }

    const ClassByTag = new Map<string, Class>()
    const TagByClass = new WeakMap<Function, string>()
    const OwnMeta = new WeakMap<Function, Map<PropertyKey, Meta>>()
    const CollectedMeta = new WeakMap<Function, Map<PropertyKey, Meta>>()
    const NoAttributes: ReadonlyMap<string, string> = new Map()

    const define = (target: Object, meta: Meta): void => {
        WeakMaps.createIfAbsent(OwnMeta, target.constructor, () => new Map<PropertyKey, Meta>()).set(meta.key, meta)
    }

    const lazyClasses = (types: Provider<Class | ReadonlyArray<Class>>): Provider<ReadonlyArray<Class>> => {
        const cache: { value: Nullable<ReadonlyArray<Class>> } = {value: null}
        return () => cache.value ??= (resolved => typeof resolved === "function" ? [resolved] : resolved)(types())
    }

    export const Attribute = (name: string, codec: AttributeValidator<unknown> = StringOptional): PropertyDecorator =>
        (target: Object, key: PropertyKey) => define(target, {type: "attribute", key, name, codec})

    export const Text = (name: string, required: boolean = false): PropertyDecorator =>
        (target: Object, key: PropertyKey) => define(target, {type: "text", key, name, required})

    const elementDecorator = (list: boolean) =>
        (types: Provider<Class | ReadonlyArray<Class>>, options?: ElementOptions): PropertyDecorator =>
            (target: Object, key: PropertyKey) => define(target, {
                type: "element", key, list,
                name: options?.name ?? null,
                wrapper: options?.wrapper ?? null,
                classes: lazyClasses(types),
                required: options?.required ?? false
            })

    export const Child = elementDecorator(false)
    export const Children = elementDecorator(true)

    const registeredSubclassesOf = (clazz: Class): ReadonlyArray<Class> => Array.from(ClassByTag.values())
        .filter(candidate => candidate === clazz || candidate.prototype instanceof clazz)

    /** @deprecated Use Xml.Child, Xml.Children or Xml.Text */
    export const Element = (name: string, clazz: Class): PropertyDecorator => {
        if (clazz === String) {return Text(name)}
        if (clazz === Array) {return Children(() => Array.from(ClassByTag.values()), {wrapper: name})}
        return Child(() => clazz, {name})
    }

    /** @deprecated Use Xml.Children */
    export const ElementRef = (clazz: Class, nodeName?: string): PropertyDecorator =>
        Children(() => registeredSubclassesOf(clazz), {
            wrapper: isDefined(nodeName) && nodeName !== TagByClass.get(clazz) ? nodeName : undefined
        })

    export const Class = (tagName: string): ClassDecorator => {
        return (constructor: Function): void => {
            assert(!ClassByTag.has(tagName), `${tagName} is already registered as a class.`)
            ClassByTag.set(tagName, constructor)
            TagByClass.set(constructor, tagName)
        }
    }

    export const tagOf = (clazz: Function): Optional<string> => TagByClass.get(clazz)

    type ListKeys<T> = { [K in keyof T]-?: NonNullable<T[K]> extends ReadonlyArray<unknown> ? K : never }[keyof T]

    export type Input<T> = Omit<T, ListKeys<T>> & Partial<Pick<T, ListKeys<T>>>

    export const element = <T extends {}>(object: Input<T>, clazz: Class<T>): T => {
        assert(clazz.length === 0, "constructor cannot have arguments")
        const instance: object = Object.create(clazz.prototype)
        Object.entries(object).forEach(([key, value]) => Object.defineProperty(instance, key, {value, enumerable: true}))
        collectMeta(clazz)?.forEach(meta => {
            if (meta.type === "element" && meta.list && !isDefined(Reflect.get(instance, meta.key))) {
                Object.defineProperty(instance, meta.key, {value: Object.freeze([]), enumerable: true})
            }
        })
        return Object.freeze(instance) as T
    }

    const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

    const isRequired = (meta: Meta): boolean => meta.type === "attribute" ? meta.codec.required : meta.required

    const formatAttribute = (codec: AttributeValidator<unknown>, value: unknown): string => {
        if (isDefined(codec.format)) {return codec.format(value)}
        const type = typeof value
        if (type !== "string" && type !== "number" && type !== "boolean") {
            return panic(`Attribute value must be a primitive (${value})`)
        }
        codec.parse(value)
        return String(value)
    }

    export const toNode = (object: object, tagName?: string): XmlNode => {
        const writeItem = (meta: ElementMeta, item: unknown, path: string): XmlNode => {
            if (typeof item !== "object" || !isDefined(item)) {return panic(`${path}: '${item}' is not an element`)}
            const classes = meta.classes()
            if (isDefined(meta.name)) {
                if (!classes.some(clazz => item instanceof clazz)) {
                    return panic(`${path}: ${item.constructor.name} is not allowed in <${meta.name}>`)
                }
                return visit(meta.name, item, `${path}/${meta.name}`)
            }
            const tag = TagByClass.get(item.constructor)
            if (!isDefined(tag) || !classes.includes(item.constructor)) {
                return panic(`${path}: ${item.constructor.name} is not allowed here`)
            }
            return visit(tag, item, `${path}/${tag}`)
        }
        const visit = (name: string, object: object, path: string): XmlNode => {
            const metas = collectMeta(object.constructor) ?? panic(`${path}: ${object.constructor.name} has no xml meta`)
            const attributes = new Map<string, string>()
            const children: Array<XmlNode> = []
            metas.forEach(meta => {
                const value: unknown = Reflect.get(object, meta.key)
                if (!isDefined(value)) {
                    if (isRequired(meta)) {panic(`${path}: missing required '${String(meta.key)}'`)}
                    return
                }
                if (meta.type === "attribute") {
                    const formatted = tryCatch(() => formatAttribute(meta.codec, value))
                    if (formatted.status === "failure") {return panic(`${path}@${meta.name}: ${messageOf(formatted.error)}`)}
                    attributes.set(meta.name, formatted.value)
                } else if (meta.type === "text") {
                    children.push({name: meta.name, attributes: NoAttributes, children: [], text: String(value)})
                } else {
                    const items: ReadonlyArray<unknown> = meta.list
                        ? Array.isArray(value) ? value.filter(isDefined) : panic(`${path}: '${String(meta.key)}' must be a list`)
                        : [value]
                    if (items.length === 0) {
                        if (meta.required) {panic(`${path}: '${String(meta.key)}' must not be empty`)}
                        return
                    }
                    const nodes = items.map(item => writeItem(meta, item, path))
                    if (isDefined(meta.wrapper)) {
                        children.push({name: meta.wrapper, attributes: NoAttributes, children: nodes, text: ""})
                    } else {
                        children.push(...nodes)
                    }
                }
            })
            return {name, attributes, children, text: ""}
        }
        const name = tagName ?? TagByClass.get(object.constructor)
            ?? panic(`Missing @Xml.Class decorator on ${object.constructor.name}`)
        return visit(name, object, name)
    }

    export const write = (object: object, options?: XmlWriter.Options & { readonly tagName?: string }): string =>
        XmlWriter.write(toNode(object, options?.tagName), options)

    /** @deprecated Use Xml.write (DOM only, not available in workers) */
    export const toElement = (tagName: string, object: object): Element =>
        new DOMParser().parseFromString(XmlWriter.write(toNode(object, tagName), {declaration: false, indent: ""}), "application/xml").documentElement

    /** @deprecated Use Xml.write (DOM only, not available in workers) */
    export const pretty = (element: Element): string =>
        XmlWriter.write(XmlReader.parse(new XMLSerializer().serializeToString(element)), {declaration: false})

    export const resolveMeta = (target: Function, propertyKey: PropertyKey): Maybe<Meta> =>
        collectMeta(target)?.get(propertyKey)

    export const collectMeta = (target: Function): Maybe<MetaMap> => {
        const chainOf = (clazz: Maybe<Function>): ReadonlyArray<Function> =>
            isDefined(clazz) && clazz !== Function.prototype ? [...chainOf(Object.getPrototypeOf(clazz)), clazz] : []
        const collected = WeakMaps.createIfAbsent(CollectedMeta, target, () => {
            const result = new Map<PropertyKey, Meta>()
            chainOf(target).forEach(clazz => OwnMeta.get(clazz)?.forEach((meta, key) => result.set(key, meta)))
            return result
        })
        return collected.size > 0 ? collected : undefined
    }

    const isIgnoredAttribute = (name: string): boolean =>
        name.startsWith("xmlns") || name.startsWith("xsi:") || name.startsWith("xml:")

    const acceptsTag = (meta: Meta, tagName: string): boolean => {
        if (meta.type === "attribute") {return false}
        if (meta.type === "text") {return meta.name === tagName}
        if (isDefined(meta.wrapper)) {return meta.wrapper === tagName}
        if (isDefined(meta.name)) {return meta.name === tagName}
        return meta.classes().some(clazz => TagByClass.get(clazz) === tagName)
    }

    const resolveClass = (meta: ElementMeta, tagName: string): Optional<Class> => {
        const classes = meta.classes()
        if (isDefined(meta.name)) {return meta.name === tagName ? classes.at(0) : undefined}
        return classes.find(clazz => TagByClass.get(clazz) === tagName)
    }

    export const readNode = <T extends {}>(root: XmlNode, clazz: Class<T>): ReadResult<T> => {
        const issues: Array<string> = []
        const deserialize = (node: XmlNode, clazz: Class, path: string): object => {
            const metas = collectMeta(clazz) ?? panic(`${path}: ${clazz.name} has no xml meta`)
            const values = new Map<PropertyKey, unknown>()
            const lists = new Map<PropertyKey, Array<unknown>>()
            const knownAttributes = new Set<string>()
            metas.forEach(meta => {
                if (meta.type === "attribute") {
                    knownAttributes.add(meta.name)
                    const raw = node.attributes.get(meta.name)
                    if (isDefined(raw)) {
                        const parsed = tryCatch(() => meta.codec.parse(raw))
                        if (parsed.status === "failure") {
                            issues.push(`${path}@${meta.name}: ${messageOf(parsed.error)}`)
                        } else {
                            values.set(meta.key, parsed.value)
                        }
                    } else if (meta.codec.required) {
                        issues.push(`${path}: missing attribute '${meta.name}'`)
                    }
                } else if (meta.type === "element" && meta.list) {
                    lists.set(meta.key, [])
                }
            })
            node.attributes.forEach((_, name) => {
                if (!knownAttributes.has(name) && !isIgnoredAttribute(name)) {
                    issues.push(`${path}: unknown attribute '${name}'`)
                }
            })
            const store = (meta: Meta, value: unknown, where: string): void => {
                const list = lists.get(meta.key)
                if (isDefined(list)) {
                    list.push(value)
                } else if (values.has(meta.key)) {
                    issues.push(`${where}: unexpected repetition`)
                } else {
                    values.set(meta.key, value)
                }
            }
            const readElement = (meta: ElementMeta, child: XmlNode, where: string): void => {
                const childClass = resolveClass(meta, child.name)
                if (!isDefined(childClass)) {
                    issues.push(`${where}: unknown element`)
                    return
                }
                store(meta, deserialize(child, childClass, where), where)
            }
            node.children.forEach(child => {
                const where = `${path}/${child.name}`
                const meta = Array.from(metas.values()).find(meta => acceptsTag(meta, child.name))
                if (!isDefined(meta) || meta.type === "attribute") {
                    issues.push(`${where}: unknown element`)
                } else if (meta.type === "text") {
                    store(meta, child.text, where)
                } else if (isDefined(meta.wrapper)) {
                    child.attributes.forEach((_, name) => {
                        if (!isIgnoredAttribute(name)) {issues.push(`${where}: unknown attribute '${name}'`)}
                    })
                    child.children.forEach(item => readElement(meta, item, `${where}/${item.name}`))
                } else {
                    readElement(meta, child, where)
                }
            })
            metas.forEach(meta => {
                if (meta.type === "attribute") {return}
                const list = lists.get(meta.key)
                if (isDefined(list)) {
                    if (meta.required && list.length === 0) {issues.push(`${path}: '${String(meta.key)}' is empty`)}
                    values.set(meta.key, Object.freeze(list))
                } else if (meta.required && !values.has(meta.key)) {
                    issues.push(`${path}: missing element '${String(meta.key)}'`)
                }
            })
            const instance: object = Object.create(clazz.prototype)
            metas.forEach(meta => Object.defineProperty(instance, meta.key, {value: values.get(meta.key), enumerable: true}))
            return Object.freeze(instance)
        }
        const expected = TagByClass.get(clazz)
        if (isDefined(expected) && expected !== root.name) {
            return panic(`Expected root element <${expected}> but found <${root.name}>`)
        }
        const value = deserialize(root, clazz, root.name)
        return {value: value as T, issues: Object.freeze(issues)}
    }

    export const read = <T extends {}>(xml: string, clazz: Class<T>): ReadResult<T> =>
        readNode(XmlReader.parse(xml), clazz)

    export const parse = <T extends {}>(xml: string, clazz: Class<T>): T => read(xml, clazz).value
}
