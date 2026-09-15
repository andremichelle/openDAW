import {Comment, Converter, DeclarationReflection, ReferenceType, ReflectionKind} from "typedoc"
import ts from "typescript"

const collect = (type, sink) => {
    if (!type) return
    if (type.type === "reference" && type.reflection) sink.add(type.reflection)
    const children = [
        ...(type.typeArguments ?? []), ...(type.types ?? []), ...(type.elements ?? []),
        type.elementType, type.element, type.checkType, type.extendsType, type.trueType, type.falseType,
        type.objectType, type.indexType, type.target, type.parameterType, type.templateType, type.nameType,
        ...(type.tail?.map(([inner]) => inner) ?? [])
    ]
    children.forEach(child => collect(child, sink))
    type.declaration?.children?.forEach(child => collect(child.type, sink))
    type.declaration?.signatures?.forEach(signature => collectSignature(signature, sink))
}

const collectSignature = (signature, sink) => {
    signature.typeParameters?.forEach(parameter => collect(parameter.type, sink))
    signature.parameters?.forEach(parameter => collect(parameter.type, sink))
    collect(signature.type, sink)
}

const label = reflection => reflection.parent?.kindOf(ReflectionKind.Project | ReflectionKind.Namespace) ? reflection.name : `${reflection.parent.name}.${reflection.name}`

const OPAQUE = new Set(["ParameterPath", "DeepPartial"])

const aliasReference = (context, typeNode) => {
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return null
    const name = typeNode.typeName.getText()
    const alias = context.project.getChildByName(name)
    const keep = alias?.kindOf(ReflectionKind.TypeAlias) === true
    if (!OPAQUE.has(name) && !keep) return null
    const reference = keep
        ? ReferenceType.createResolvedReference(name, alias, context.project)
        : ReferenceType.createBrokenReference(name, context.project)
    reference.typeArguments = typeNode.typeArguments?.map(argument => context.converter.convertType(context, argument))
    return reference
}

export const load = app => {
    app.converter.on(Converter.EVENT_CREATE_SIGNATURE, (context, signature, node) => {
        if (!node || !ts.isFunctionLike(node)) return
        node.parameters.forEach((parameterNode, index) => {
            const reference = aliasReference(context, parameterNode.type)
            if (reference) signature.parameters[index].type = reference
        })
        const returnReference = aliasReference(context, node.type)
        if (returnReference) signature.type = returnReference
    })
    app.converter.on(Converter.EVENT_RESOLVE_END, context => {
        const project = context.project
        const usages = new Map()
        const note = (targets, site) => targets.forEach(target => {
            if (target === site.parent || target === site) return
            if (!usages.has(target)) usages.set(target, new Map())
            usages.get(target).set(label(site), site)
        })
        project.getReflectionsByKind(ReflectionKind.Property | ReflectionKind.Accessor).forEach(property => {
            if (property.inheritedFrom || property.parent.kindOf(ReflectionKind.TypeLiteral)) return
            const sink = new Set()
            collect(property.type, sink)
            note(sink, property)
        })
        project.getReflectionsByKind(ReflectionKind.Method).forEach(method => {
            if (method.inheritedFrom) return
            const sink = new Set()
            method.signatures?.forEach(signature => collectSignature(signature, sink))
            note(sink, method)
        })
        project.getReflectionsByKind(ReflectionKind.TypeAlias).forEach(alias => {
            const sink = new Set()
            collect(alias.type, sink)
            note(sink, alias)
        })
        const linkTypes = (member, sink) => {
            const targets = [...sink].filter(target => target !== member.parent && target.kindOf(ReflectionKind.Interface | ReflectionKind.TypeAlias))
            if (targets.length === 0) return
            member.comment ??= new Comment([])
            targets.forEach(target => member.comment.blockTags.push({
                tag: "@see", content: [{kind: "inline-tag", tag: "@link", text: target.name, target}]
            }))
        }
        project.getReflectionsByKind(ReflectionKind.Property).forEach(property => {
            if (property.inheritedFrom || property.parent.kindOf(ReflectionKind.TypeLiteral)) return
            const sink = new Set()
            collect(property.type, sink)
            linkTypes(property, sink)
        })
        project.getReflectionsByKind(ReflectionKind.Method).forEach(method => {
            if (method.inheritedFrom) return
            const sink = new Set()
            method.signatures?.forEach(signature => signature.parameters?.forEach(parameter => collect(parameter.type, sink)))
            linkTypes(method, sink)
        })
        usages.forEach((sites, target) => {
            if (!target.kindOf(ReflectionKind.Interface | ReflectionKind.TypeAlias)) return
            const sorted = [...sites.entries()].sort(([left], [right]) => left.localeCompare(right))
            target.comment ??= new Comment([])
            sorted.forEach(([text, site]) => target.comment.blockTags.push({
                tag: "@see", content: [{kind: "inline-tag", tag: "@link", text, target: site}]
            }))
        })
    })
    app.converter.on(Converter.EVENT_RESOLVE_BEGIN, context => {
        const project = context.project
        const namespaces = new Map()
        project.children?.slice().forEach(child => {
            if (child.kindOf(ReflectionKind.Document | ReflectionKind.Namespace)) return
            const group = child.comment?.blockTags.find(tag => tag.tag === "@group")
            // U+2800 renders blank but is not whitespace, the theme splits slugs on whitespace
            const name = group ? Comment.combineDisplayParts(group.content).trim().replace(/ /g, "\u2800") : "Globals"
            if (!namespaces.has(name)) {
                const namespace = new DeclarationReflection(name, ReflectionKind.Namespace, project)
                project.addChild(namespace)
                project.registerReflection(namespace, undefined, undefined)
                namespaces.set(name, namespace)
            }
            project.removeChild(child)
            child.parent = namespaces.get(name)
            namespaces.get(name).addChild(child)
        })
    })
}
