import {isDefined, Nullable, Optional, panic} from "@opendaw/lib-std"
import {XmlNode, XmlReader} from "@opendaw/lib-xml"

export namespace SchemaGenerator {
    type Attribute = { readonly name: string, readonly tsType: string, readonly codec: string, readonly required: boolean }
    type Element = {
        readonly field: string, readonly classes: ReadonlyArray<string>, readonly name: Nullable<string>,
        readonly wrapper: Nullable<string>, readonly list: boolean, readonly required: boolean, readonly text: boolean
    }
    type ComplexType = {
        readonly name: string, readonly abstract: boolean, readonly base: Nullable<string>,
        readonly attributes: ReadonlyArray<Attribute>, readonly elements: ReadonlyArray<Element>
    }

    // attributes the reference implementation maps through its DoubleAdapter ("inf" instead of "INF")
    const DawDoubles: ReadonlyMap<string, ReadonlySet<string>> = new Map([
        ["realParameter", new Set(["max", "min", "value"])],
        ["point", new Set(["time"])],
        ["note", new Set(["time", "duration", "vel", "rel"])],
        ["realPoint", new Set(["value"])]
    ])

    const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.substring(1)
    const decapitalize = (text: string): string => text.charAt(0).toLowerCase() + text.substring(1)
    const className = (type: string): string => `${capitalize(type)}Schema`
    const enumName = (type: string): string => capitalize(type)
    const enumMember = (value: string): string => value.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()
    const children = (node: XmlNode, name: string): ReadonlyArray<XmlNode> =>
        node.children.filter(child => child.name === `xs:${name}`)
    const child = (node: XmlNode, name: string): Optional<XmlNode> => children(node, name).at(0)
    const requireChild = (node: XmlNode, name: string): XmlNode =>
        child(node, name) ?? panic(`Missing <xs:${name}> in <${node.name}>`)
    const attribute = (node: XmlNode, name: string): Optional<string> => node.attributes.get(name)
    const requireAttribute = (node: XmlNode, name: string): string =>
        attribute(node, name) ?? panic(`Missing attribute '${name}' in <${node.name}>`)
    const minOccurs = (node: XmlNode): number => Number(attribute(node, "minOccurs") ?? "1")
    const isUnbounded = (node: XmlNode): boolean => attribute(node, "maxOccurs") === "unbounded"

    export const generate = (sources: ReadonlyArray<string>): string => {
        const schemas = sources.map(source => XmlReader.parse(source))
        const topElements = new Map<string, string>()
        const enums = new Map<string, ReadonlyArray<string>>()
        const complexNodes = new Map<string, XmlNode>()
        schemas.forEach(schema => {
            children(schema, "element").forEach(node =>
                topElements.set(requireAttribute(node, "name"), requireAttribute(node, "type")))
            children(schema, "simpleType").forEach(node => enums.set(requireAttribute(node, "name"),
                children(requireChild(node, "restriction"), "enumeration").map(value => requireAttribute(value, "value"))))
            children(schema, "complexType").forEach(node => complexNodes.set(requireAttribute(node, "name"), node))
        })
        const tagOfType = new Map(Array.from(topElements, ([tag, type]) => [type, tag]))
        const classOfRef = (ref: string): string => className(topElements.get(ref) ?? panic(`Unknown element ref '${ref}'`))
        const resolveAttribute = (owner: string, node: XmlNode): Attribute => {
            const name = requireAttribute(node, "name")
            const required = attribute(node, "use") === "required"
            const suffix = required ? "Required" : "Optional"
            const type = attribute(node, "type")
            if (!isDefined(type)) {
                const itemType = requireAttribute(requireChild(requireChild(node, "simpleType"), "list"), "itemType")
                if (itemType === "xs:string") {
                    return {name, required, tsType: "ReadonlyArray<string>", codec: `Xml.List(Xml.StringRequired, ${required})`}
                }
                return {
                    name, required, tsType: `ReadonlyArray<${enumName(itemType)}>`,
                    codec: `Xml.List(Xml.Enum(${enumName(itemType)}, true), ${required})`
                }
            }
            if (DawDoubles.get(owner)?.has(name) === true) {return {name, required, tsType: "number", codec: `DawCodecs.Double${suffix}`}}
            switch (type) {
                case "xs:string":
                case "xs:ID":
                case "xs:IDREF":
                    return {name, required, tsType: "string", codec: `Xml.String${suffix}`}
                case "xs:double":
                    return {name, required, tsType: "number", codec: `Xml.Number${suffix}`}
                case "xs:int":
                    return {name, required, tsType: "int", codec: `Xml.Int${suffix}`}
                case "xs:boolean":
                    return {name, required, tsType: "boolean", codec: `Xml.Bool${suffix}`}
            }
            if (enums.has(type)) {return {name, required, tsType: enumName(type), codec: `Xml.Enum(${enumName(type)}, ${required})`}}
            return panic(`Unknown attribute type '${type}'`)
        }
        const resolveChoice = (owner: string, node: XmlNode, wrapper: Nullable<string>, optional: boolean): Element => {
            const list = isUnbounded(node)
            const classes = children(node, "element").map(element => classOfRef(requireAttribute(element, "ref")))
            const field = isDefined(wrapper) ? decapitalize(wrapper) : list ? owner : "content"
            return {field, classes, name: null, wrapper, list: list || isDefined(wrapper), required: !optional && minOccurs(node) > 0, text: false}
        }
        const resolveElement = (owner: string, node: XmlNode): Element => {
            const ref = attribute(node, "ref")
            const list = isUnbounded(node)
            const required = minOccurs(node) > 0
            if (isDefined(ref)) {
                return {field: decapitalize(ref) + (list ? "s" : ""), classes: [classOfRef(ref)], name: null, wrapper: null, list, required, text: false}
            }
            const name = requireAttribute(node, "name")
            const type = attribute(node, "type")
            if (!isDefined(type)) {
                const sequence = requireChild(requireChild(node, "complexType"), "sequence")
                const inner = child(sequence, "choice") ?? requireChild(sequence, "element")
                if (inner.name === "xs:choice") {return resolveChoice(owner, inner, name, !required)}
                const element = resolveElement(owner, inner)
                return {...element, field: decapitalize(name), wrapper: name, list: true, required}
            }
            if (type === "xs:string") {
                return {field: decapitalize(name), classes: [], name, wrapper: null, list: false, required, text: true}
            }
            return {field: decapitalize(name) + (list ? "s" : ""), classes: [className(type)], name, wrapper: null, list, required, text: false}
        }
        const resolveParticles = (owner: string, node: Optional<XmlNode>): ReadonlyArray<Element> => {
            if (!isDefined(node)) {return []}
            if (node.name === "xs:choice") {return [resolveChoice(owner, node, null, false)]}
            return node.children.flatMap(particle => {
                if (particle.name === "xs:element") {return [resolveElement(owner, particle)]}
                if (particle.name === "xs:choice") {return [resolveChoice(owner, particle, null, minOccurs(particle) === 0)]}
                return panic(`Unsupported particle '${particle.name}' in '${owner}'`)
            })
        }
        const types: ReadonlyArray<ComplexType> = Array.from(complexNodes, ([name, node]) => {
            const extension = child(child(node, "complexContent") ?? node, "extension")
            const body = extension ?? node
            return {
                name,
                abstract: attribute(node, "abstract") === "true",
                base: isDefined(extension) ? requireAttribute(extension, "base") : null,
                attributes: children(body, "attribute").map(attributeNode => resolveAttribute(name, attributeNode)),
                elements: resolveParticles(name, child(body, "sequence") ?? child(body, "choice"))
            }
        })
        const ordered: Array<ComplexType> = []
        const visit = (type: ComplexType): void => {
            if (ordered.includes(type)) {return}
            if (isDefined(type.base)) {visit(types.find(candidate => candidate.name === type.base) ?? panic(`Unknown base '${type.base}'`))}
            ordered.push(type)
        }
        types.forEach(visit)
        const lines: Array<string> = []
        lines.push("// Generated from Project.xsd and MetaData.xsd by generator/SchemaGenerator.ts, do not edit.")
        lines.push("import type {int} from \"@opendaw/lib-std\"")
        lines.push("import {Xml} from \"@opendaw/lib-xml\"")
        lines.push("import {DawCodecs} from \"./DawCodecs\"")
        enums.forEach((values, name) => {
            lines.push("", `export enum ${enumName(name)} {`)
            lines.push(values.map(value => `    ${enumMember(value)} = "${value}"`).join(",\n"))
            lines.push("}")
        })
        const commonBase = (element: Element): string => {
            if (element.classes.length === 1) {return element.classes[0]}
            const chains = element.classes.map(name => {
                const chain: Array<string> = []
                const walk = (type: Optional<ComplexType>): void => {
                    if (!isDefined(type)) {return}
                    chain.unshift(className(type.name))
                    walk(types.find(candidate => candidate.name === type.base))
                }
                walk(types.find(candidate => className(candidate.name) === name))
                return chain
            })
            const common = chains[0].filter((name, index) => chains.every(chain => chain[index] === name))
            return common.at(-1) ?? "object"
        }
        ordered.forEach(type => {
            const tag = tagOfType.get(type.name)
            lines.push("")
            if (isDefined(tag)) {lines.push(`@Xml.Class("${tag}")`)}
            const extendsClause = isDefined(type.base) ? ` extends ${className(type.base)}` : ""
            lines.push(`export ${type.abstract ? "abstract " : ""}class ${className(type.name)}${extendsClause} {`)
            type.attributes.forEach(({name, tsType, codec, required}) =>
                lines.push(`    @Xml.Attribute("${name}", ${codec}) declare readonly ${name}${required ? "" : "?"}: ${tsType}`))
            type.elements.forEach(element => {
                const optional = element.required || element.list ? "" : "?"
                const single = element.text ? "string" : commonBase(element)
                const declaration = `declare readonly ${element.field}${optional}: ${element.list ? `ReadonlyArray<${single}>` : single}`
                if (element.text) {
                    lines.push(`    @Xml.Text("${element.name}"${element.required ? ", true" : ""}) ${declaration}`)
                    return
                }
                const classes = element.classes.length === 1 ? element.classes[0] : `[${element.classes.join(", ")}]`
                const options = [
                    isDefined(element.name) ? `name: "${element.name}"` : null,
                    isDefined(element.wrapper) ? `wrapper: "${element.wrapper}"` : null,
                    element.required ? "required: true" : null
                ].filter(isDefined)
                const optionsCode = options.length > 0 ? `, {${options.join(", ")}}` : ""
                lines.push(`    @Xml.${element.list ? "Children" : "Child"}(() => ${classes}${optionsCode}) ${declaration}`)
            })
            lines.push("}")
        })
        return lines.join("\n") + "\n"
    }
}
