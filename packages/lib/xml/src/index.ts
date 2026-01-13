import {asDefined, assert, Class, int, isDefined, Maybe, panic, WeakMaps} from "@moises-ai/lib-std"

export namespace Xml {
    type Meta =
        | { type: "class", name: string, clazz: Class }
        | { type: "element", name: string, clazz: Class }
        | { type: "element-ref", clazz: Class, name: string | null }
        | { type: "attribute", name: string, validator?: AttributeValidator<unknown> }
    type MetaMap = Map<PropertyKey, Meta>

    const ClassMap = new Map<string, Class>()
    const MetaClassMap = new WeakMap<Function, MetaMap>()

    export const Declaration = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"

    export interface AttributeValidator<T> {
        required: boolean
        parse(value: string | T): T
    }

    export const StringRequired: AttributeValidator<string> = {required: true, parse: value => value}
    export const StringOptional: AttributeValidator<string> = {required: false, parse: value => value}

    export const BoolRequired: AttributeValidator<boolean> = {
        required: true,
        parse: value => typeof value === "boolean" ? value : value?.toLowerCase() === "true"
    }
    export const BoolOptional: AttributeValidator<boolean> = {
        required: false,
        parse: value => typeof value === "boolean" ? value : value?.toLowerCase() === "true"
    }

    export const NumberRequired: AttributeValidator<number> = {
        required: true, parse: value => {
            const number = Number(value)
            return isNaN(number) ? panic("NumberRequired") : number
        }
    }
    export const NumberOptional: AttributeValidator<number> = {required: false, parse: value => Number(value)}

    export const Attribute = (name: string, validator?: AttributeValidator<unknown>): PropertyDecorator =>
        (target: Object, propertyKey: PropertyKey) =>
            WeakMaps.createIfAbsent(MetaClassMap, target.constructor, () => new Map<PropertyKey, Meta>())
                .set(propertyKey, {type: "attribute", name, validator})

    export const Element = (name: string, clazz: Class): PropertyDecorator =>
        (target: Object, propertyKey: PropertyKey) =>
            WeakMaps.createIfAbsent(MetaClassMap, target.constructor, () => new Map<PropertyKey, Meta>())
                .set(propertyKey, {type: "element", name, clazz})

    export const ElementRef = (clazz: Class, nodeName?: string): PropertyDecorator =>
        (target: Object, propertyKey: PropertyKey) =>
            WeakMaps.createIfAbsent(MetaClassMap, target.constructor, () => new Map<PropertyKey, Meta>())
                .set(propertyKey, {type: "element-ref", clazz, name: nodeName ?? null})

    export const Class = (tagName: string): ClassDecorator => {
        return (constructor: Function): void => {
            assert(!ClassMap.has(tagName), `${tagName} is already registered as a class.`)
            ClassMap.set(tagName, constructor)
            WeakMaps.createIfAbsent(MetaClassMap, constructor, () => new Map<PropertyKey, Meta>())
                .set("class", {type: "class", name: tagName, clazz: constructor})
        }
    }

    export const element = <T extends {}>(object: T, clazz: Class<T>): T => {
        assert(clazz.length === 0, "constructor cannot have arguments")
        return Object.freeze(Object.create(clazz.prototype, Object.fromEntries(
            Object.entries(object).map(([key, value]) => [key, {value, enumerable: true}]))))
    }

    export const toElement = (tagName: string, object: Record<string, any>): Element => {
        const doc = document.implementation.createDocument(null, null)
        const getClassTagName = (constructor: Function): string => {
            const tagMeta = MetaClassMap.get(constructor)?.get("class")
            if (tagMeta?.type === "class") {
                return tagMeta.name
            }
            return panic(`Missing @Xml.Class decorator on ${constructor.name}`)
        }

        const visit = (tagName: string, object: Record<string, any>): Element => {
            const element = doc.createElement(tagName)
            Object.entries(object).forEach(([key, value]) => {
                if (!isDefined(value)) return
                const meta = resolveMeta(object.constructor, key)
                if (!isDefined(meta)) return
                if (meta.type === "attribute") {
                    assert(typeof value === "number" || typeof value === "string" || typeof value === "boolean",
                        `Attribute value must be a primitive for ${key} = ${value}`)
                    meta.validator?.parse?.call(null, value)
                    element.setAttribute(meta.name, String(value))
                } else if (meta.type === "element") {
                    if (Array.isArray(value)) {
                        if (value.length === 0) return
                        const wrapper = doc.createElement(meta.name)
                        value.forEach(item => {
                            if (!isDefined(item)) return
                            const itemTagName = getClassTagName(item.constructor)
                            wrapper.appendChild(visit(itemTagName, item))
                        })
                        element.appendChild(wrapper)
                    } else if (typeof value === "string") {
                        const child = doc.createElement(meta.name)
                        child.textContent = value
                        element.appendChild(child)
                    } else {
                        element.appendChild(visit(meta.name, value))
                    }
                } else if (meta.type === "element-ref") {
                    if (!Array.isArray(value)) return panic("ElementRef must be an array of items.")
                    if (value.length === 0) return
                    const validItems = value.filter(isDefined)
                    if (validItems.length === 0) return

                    if (meta.name) {
                        const firstItemTagName = getClassTagName(validItems[0].constructor)
                        if (meta.name === firstItemTagName) {
                            // Direct elements case
                            validItems.forEach(item => element.appendChild(visit(meta.name!, item)))
                        } else {
                            // Wrapper case
                            const wrapper = doc.createElement(meta.name)
                            validItems.forEach(item => wrapper.appendChild(visit(getClassTagName(item.constructor), item)))
                            element.appendChild(wrapper)
                        }
                    } else {
                        // No meta.name, use class tag names directly
                        validItems.forEach(item => element.appendChild(visit(getClassTagName(item.constructor), item)))
                    }
                }
            })
            return element
        }

        return visit(tagName, object)
    }

    export const pretty = (element: Element): string => {
        const PADDING = "  " // 2 spaces
        const reg = /(>)(<)(\/*)/g
        const xml = new XMLSerializer()
            .serializeToString(element)
            .replace(reg, "$1\n$2$3")
        let pad: int = 0
        return xml.split("\n").map(line => {
            let indent: int = 0
            if (line.match(/.+<\/\w[^>]*>$/)) {
                indent = 0
            } else if (line.match(/^<\/\w/) && pad > 0) {
                pad -= 1
            } else if (line.match(/^<\w[^>]*[^\/]>.*$/)) {
                indent = 1
            } else {
                indent = 0
            }
            const padding = PADDING.repeat(pad)
            pad += indent
            return padding + line
        }).join("\n")
    }

    export const resolveMeta = (target: Function, propertyKey: PropertyKey): Maybe<Meta> =>
        collectMeta(target)?.get(propertyKey)

    export const collectMeta = (target: Function): Maybe<MetaMap> => {
        const metaMap: MetaMap = new Map<PropertyKey, Meta>()
        while (isDefined(target)) {
            const meta = MetaClassMap.get(target)
            if (isDefined(meta)) {
                for (const [key, value] of meta.entries()) {
                    metaMap.set(key, value)
                }
            }
            target = Object.getPrototypeOf(target)
        }
        return metaMap.size > 0 ? metaMap : undefined
    }

    const findChildByName = (parent: Element, name: string): Element | null => {
        for (const child of parent.children) {
            if (child.nodeName === name) {
                return child
            }
        }
        return null
    }

    const findAllChildrenByName = (parent: Element, name: string): Element[] => {
        const result: Element[] = []
        for (const child of parent.children) {
            if (child.nodeName === name) {
                result.push(child)
            }
        }
        return result
    }

    export const parse = <T extends {}>(xml: string, clazz: Class<T>): T => {
        const deserialize = <T extends {}>(element: Element, clazz: Class<unknown>): T => {
            const instance = Object.create(clazz.prototype) as T
            const classMeta = asDefined(Xml.collectMeta(clazz))
            const classMetaDict: Record<keyof T, Meta> = Array.from(classMeta).reduce((acc: any, [key, metaInfo]) => {
                acc[key] = metaInfo
                return acc
            }, {})
            const keys = [...classMeta.keys()].filter(key => key !== "class") as Array<keyof T>

            for (const key of keys) {
                const meta: Meta = classMetaDict[key]

                if (meta.type === "attribute") {
                    const attribute = element.getAttribute(meta.name)
                    if (isDefined(attribute)) {
                        Object.defineProperty(instance, key, {
                            value: meta.validator?.parse?.call(null, attribute) ?? attribute,
                            enumerable: true
                        })
                    } else {
                        meta.validator?.required && panic(`Missing attribute '${meta.name}'`)
                        Object.defineProperty(instance, key, {value: undefined, enumerable: true})
                    }
                } else if (meta.type === "element") {
                    const {name, clazz: elementClazz} = meta
                    if (elementClazz === Array) {
                        const wrapperElement = findChildByName(element, name)
                        if (wrapperElement) {
                            const items = Array.from(wrapperElement.children).map(child => {
                                const clazz = ClassMap.get(child.nodeName)
                                if (!clazz) {
                                    console.warn(`Could not find class for '${child.nodeName}', skipping`)
                                    return null
                                }
                                return deserialize(child, clazz)
                            }).filter(item => item !== null)
                            Object.defineProperty(instance, key, {value: items, enumerable: true})
                        } else {
                            Object.defineProperty(instance, key, {value: [], enumerable: true})
                        }
                    } else if (elementClazz === String) {
                        const textElement = findChildByName(element, name)
                        const textContent = textElement?.textContent
                        Object.defineProperty(instance, key, {value: textContent, enumerable: true})
                    } else {
                        const child = findChildByName(element, name)
                        if (child) {
                            Object.defineProperty(instance, key, {
                                value: deserialize(child, elementClazz),
                                enumerable: true
                            })
                        } else {
                            Object.defineProperty(instance, key, {value: undefined, enumerable: true})
                        }
                    }

                } else if (meta.type === "element-ref") {
                    if (meta.name) {
                        const directElements = findAllChildrenByName(element, meta.name)
                        if (directElements.length > 0 && directElements[0].children.length === 0) {
                            // Direct elements case
                            const items = directElements.map(child => {
                                const clazz = ClassMap.get(child.nodeName)
                                if (!clazz) return null
                                return deserialize(child, clazz)
                            }).filter(item => item !== null)
                            Object.defineProperty(instance, key, {value: items, enumerable: true})
                        } else {
                            // Wrapper case
                            const wrapperElement = findChildByName(element, meta.name)
                            if (wrapperElement && wrapperElement.children.length > 0) {
                                const items = Array.from(wrapperElement.children).map(child => {
                                    const clazz = ClassMap.get(child.nodeName)
                                    if (!clazz) return null
                                    if (!(clazz === meta.clazz || clazz.prototype instanceof meta.clazz)) {
                                        return null
                                    }
                                    return deserialize(child, clazz)
                                }).filter(item => item !== null)
                                Object.defineProperty(instance, key, {value: items, enumerable: true})
                            } else {
                                Object.defineProperty(instance, key, {value: [], enumerable: true})
                            }
                        }
                    } else {
                        // No meta.name, collect all matching children directly
                        const items = Array.from(element.children).map(child => {
                            const clazz = ClassMap.get(child.nodeName)
                            if (!clazz) return null
                            if (!(clazz === meta.clazz || clazz.prototype instanceof meta.clazz)) {
                                return null
                            }
                            return deserialize(child, clazz)
                        }).filter(item => item !== null)
                        Object.defineProperty(instance, key, {value: items, enumerable: true})
                    }
                }
            }
            return instance
        }
        const xmlDoc = new DOMParser().parseFromString(xml.trimStart(), "application/xml").documentElement
        return deserialize(xmlDoc, clazz)
    }
}