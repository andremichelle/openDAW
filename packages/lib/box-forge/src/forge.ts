import {
    Arrays,
    asDefined,
    assert,
    asValidIdentifier,
    isDefined,
    isNotUndefined,
    isValidIdentifier,
    Maybe,
    Nullable,
    panic,
    SetMultimap,
    Strings,
    Unhandled
} from "@opendaw/lib-std"
import {ByteArrayField, Constraints, FieldKey, NoPointers, PointerRules, PointerTypes} from "@opendaw/lib-box"
import {ModuleDeclarationKind, Project, Scope, SourceFile, VariableDeclarationKind} from "ts-morph"
import {AnyField, BoxSchema, ClassSchema, FieldName, Referencable, ResourceType, Schema} from "./schema"
import {header} from "./header"

const reversed_field_names = new Set(["constructor", "pointers", "name", "address"])

export class BoxForge<E extends PointerTypes> {
    static gen<E extends PointerTypes>(schema: Schema<E>): Promise<void> {
        const time = Date.now()
        console.debug(`start forging schema into ${schema.path}`)
        const project = new Project()
        const forge = new BoxForge<E>(project, schema, schema.path)
        forge.#writeBoxVisitor()
        forge.#writeBoxClasses()
        forge.#writeBoxIndex()
        forge.#writeBoxIO()
        console.debug(`compiled in ${(Date.now() - time).toFixed(1)}ms`)
        return project.save()
    }

    readonly #project: Project
    readonly #schema: Schema<E>
    readonly #path: string

    readonly #written = new Map<string, ClassSchema<E>>()

    private constructor(project: Project, schema: Schema<E>, path: string) {
        this.#project = project
        this.#schema = schema
        this.#path = path
    }

    writeClass(schema: ClassSchema<E>, option: ClassOptions, pointerRules: PointerRules<E>, resource?: ResourceType): void {
        const written: Maybe<ClassSchema<E>> = this.#written.get(schema.name)
        if (isDefined(written)) {
            if (written === schema) {
                return
            }
            if (JSON.stringify(written) === JSON.stringify(schema)) {
                console.warn(`we already wrote ${schema.name} with the very same properties. Consider merging.`)
                return
            }
        }
        const file: SourceFile = this.#project.createSourceFile(`${this.#path}/${schema.name}.ts`, header)
        ClassWriter.write(this, file, schema, option, pointerRules, resource)
        this.#written.set(schema.name, schema)
    }

    pointers(): Schema<E>["pointers"] {return this.#schema.pointers}

    #writeBoxVisitor(): void {
        const file: SourceFile = this.#project.createSourceFile(`${this.#path}/visitor.ts`, header)
        file.addImportDeclarations([
            {moduleSpecifier: "@opendaw/lib-box", namedImports: ["VertexVisitor"]},
            {moduleSpecifier: ".", namedImports: this.#schema.boxes.map(({class: {name}}) => name)}
        ])
        file.addInterface({
            name: "BoxVisitor",
            typeParameters: ["R = void"],
            extends: ["VertexVisitor<R>"],
            isExported: true,
            methods: this.#schema.boxes.map(({class: {name}}) => ({
                name: `visit${name}`,
                hasQuestionToken: true,
                parameters: [{name: "box", type: name}],
                returnType: "R"
            }))
        })
    }

    #writeBoxClasses(): void {
        this.#schema.boxes.forEach((box: BoxSchema<E>) =>
            this.writeClass(box.class, BoxClassOption, box.pointerRules ?? NoPointers, box.resource))
    }

    #writeBoxIndex(): void {
        const file: SourceFile = this.#project.createSourceFile(`${this.#path}/index.ts`, header)
        file.addStatements(`export * from "./io"`)
        file.addStatements(`export * from "./visitor"`)
        this.#schema.boxes.forEach(box => file.addStatements(`export * from "./${box.class.name}"`))
        this.#written.forEach((_, name) => file.addStatements(`export * from "./${name}"`))
    }

    #writeBoxIO(): void {
        const file: SourceFile = this.#project.createSourceFile(`${this.#path}/io.ts`, header)
        const boxes = this.#schema.boxes
        file.addImportDeclarations([
            {moduleSpecifier: ".", namedImports: boxes.map(({class: {name}}) => name)},
            {moduleSpecifier: STD_LIBRARY, namedImports: ["ByteArrayInput", "panic", "Procedure", "UUID"]},
            {moduleSpecifier: BOX_LIBRARY, namedImports: ["BoxGraph", "Box"]}
        ])
        const module = file.addModule({
            name: "BoxIO",
            isExported: true,
            declarationKind: ModuleDeclarationKind.Namespace
        })
        module.addInterface({
            isExported: true,
            name: "TypeMap",
            properties: boxes.map(({class: {name}}) => ({name: `'${name}'`, type: name}))
        })

        module.addVariableStatement({
            isExported: true,
            declarationKind: VariableDeclarationKind.Const,
            declarations: [{
                name: "create",
                initializer: `<K extends keyof TypeMap, V extends TypeMap[K]>(
					name: K, graph: BoxGraph<TypeMap>, uuid: UUID.Bytes, constructor?: Procedure<V>): V => {
      				switch (name) {${boxes.map(({class: {name}}) =>
                    `case "${name}": return ${name}.create(graph, uuid, constructor as Procedure<${name}>) as V`).join("\n")}
				default: return panic(\`Unknown box class '\${name}'\`)
				}}`
            }]
        })
        module.addVariableStatement({
            isExported: true,
            declarationKind: VariableDeclarationKind.Const,
            declarations: [{
                name: "deserialize",
                initializer: `(graph: BoxGraph, buffer: ArrayBuffer): Box => {
								const stream = new ByteArrayInput(buffer)
								const className = stream.readString() as keyof TypeMap
								const uuidBytes = UUID.fromDataInput(stream)
								const box = create(className, graph, uuidBytes)
								box.read(stream)
								return box
							}`
            }]
        })
    }
}

const STD_LIBRARY = "@opendaw/lib-std" as const
const BOX_LIBRARY = "@opendaw/lib-box" as const

type ClassOptions = Readonly<{
    import_std_lib: string[]
    import_box_lib: string[]
    extends: "Box" | "ObjectField"
    construct: "BoxConstruct" | "FieldConstruct"
    isBox: boolean
}>

export const BoxClassOption: ClassOptions = {
    import_std_lib: ["Maybe", "safeExecute", "UUID"],
    import_box_lib: ["Box", "BoxConstruct", "BoxGraph", "ResourceType"],
    extends: "Box",
    construct: "BoxConstruct",
    isBox: true
}

export const FieldClassOption: ClassOptions = {
    import_std_lib: [],
    import_box_lib: ["ObjectField", "FieldConstruct"],
    extends: "ObjectField",
    construct: "FieldConstruct",
    isBox: false
}

type FieldPrinter = Readonly<{
    fieldKey: FieldKey
    fieldName: string
    fieldValue?: string | number | boolean | Int8Array
    importPath: string
    className: string
    new: string
    type: string
    deprecated: boolean
    ctorParams: ReadonlyArray<unknown>
}>

type PointerRulesPrinter = Readonly<{
    isEmpty: boolean
    union: string
    array: string
    mandatory: boolean
    exclusive: boolean
}>

export const PrimitiveFields = Object.freeze({
    int32: "Int32Field",
    float32: "Float32Field",
    boolean: "BooleanField",
    string: "StringField",
    bytes: "ByteArrayField"
})

class ClassWriter<E extends PointerTypes> {
    static write<E extends PointerTypes>(
        generator: BoxForge<E>,
        file: SourceFile,
        schema: ClassSchema<E>,
        option: ClassOptions,
        edges: PointerRules<E>,
        resource?: ResourceType): void {
        const writer = new ClassWriter<E>(generator, file, schema, option, edges, resource)
        writer.#writeFieldsType()
        writer.#writeClass()
        writer.#writeImports()
    }

    readonly #generator: BoxForge<E>
    readonly #file: SourceFile
    readonly #schema: ClassSchema<E>
    readonly #option: ClassOptions
    readonly #pointerRules: PointerRules<E>
    readonly #resource?: ResourceType

    readonly #imports: SetMultimap<string, string>
    readonly #fieldPrinter: ReadonlyArray<FieldPrinter>

    #usesPointerType: boolean = false

    private constructor(
        generator: BoxForge<E>,
        file: SourceFile,
        schema: ClassSchema<E>,
        option: ClassOptions,
        pointerRules: PointerRules<E>,
        resource?: ResourceType) {
        this.#generator = generator
        this.#file = file
        this.#schema = schema
        this.#option = option
        this.#pointerRules = pointerRules
        this.#resource = resource

        this.#imports = new SetMultimap<string, string>([
            [STD_LIBRARY, option.import_std_lib],
            [BOX_LIBRARY, option.import_box_lib]
        ])
        const keys = Object.keys(schema.fields)
        assert(!Arrays.hasDuplicates(keys),
            `${schema.name} has duplicate field keys (${keys}).`)
        const names = Object.values(schema.fields).map(field => field.name)
        assert(!Arrays.hasDuplicates(names), `${schema.name} has duplicate field names (${names}).`)
        this.#fieldPrinter = Object.entries(schema.fields)
            .map(([key, value]) => this.#printField(Number(key), value)!)
            .filter(field => isDefined(field))
        this.#fieldPrinter.forEach(fields => this.#imports.add(fields.importPath, fields.className))
    }

    #writeFieldsType(): void {
        this.#file.addTypeAlias({
            isExported: true,
            name: this.#fieldsTypeName(),
            type: `{${this.#fieldPrinter.map(print => {
                const postfix = print.deprecated ? "// deprecated" : ""
                return isDefined(print.fieldValue)
                    ? `${print.fieldKey}: /* ${print.fieldName}: ${print.fieldValue} */ ${print.type} ${postfix}`
                    : `${print.fieldKey}: /* ${print.fieldName} */ ${print.type} ${postfix}`
            }).join("\n")}
				}`
        })
    }

    #writeClass(): void {
        const {
            union: edgesUnion,
            array: edgesArray,
            isEmpty: noEdgeConstrains,
            mandatory: edgeMandatory,
            exclusive: edgeExclusive
        } = this.#printPointerTypes(this.#pointerRules)
        const className = this.#schema.name
        const fieldsType = this.#fieldsTypeName()
        const declaration = this.#file.addClass({
            isExported: true,
            name: className,
            extends: this.#option.isBox
                ? `${this.#option.extends}<${edgesUnion}, ${fieldsType}>`
                : `${this.#option.extends}<${fieldsType}>`
        })
        if (noEdgeConstrains) {
            this.#imports.add("@opendaw/lib-box", "UnreferenceableType")
        }
        if (this.#option.isBox) {
            let pointerRules
            if (noEdgeConstrains) {
                this.#imports.add(BOX_LIBRARY, "NoPointers")
                pointerRules = "NoPointers"
            } else {
                pointerRules = `{accepts: [${edgesArray}], mandatory: ${edgeMandatory}, exclusive: ${edgeExclusive}}`
            }
            this.#imports.addAll(STD_LIBRARY, ["Procedure", "safeExecute"])
            const resourceValue = isDefined(this.#resource) ? `"${this.#resource}"` : "undefined"
            declaration.addMethod({
                name: "create",
                isStatic: true,
                parameters: [
                    {name: "graph", type: "BoxGraph"},
                    {name: "uuid", type: "UUID.Bytes"},
                    {name: "constructor", type: `Procedure<${className}>`, hasQuestionToken: true}
                ],
                statements: `return graph.stageBox(new ${className}({uuid, graph, name: "${className}", pointerRules: ${pointerRules}, resource: ${resourceValue}}), constructor)`,
                returnType: className
            })
            declaration.addProperty({
                name: "ClassName",
                type: "string",
                isStatic: true,
                isReadonly: true,
                initializer: `"${className}"`
            })
            declaration.addProperty({
                name: "Resource",
                type: "ResourceType | undefined",
                isStatic: true,
                isReadonly: true,
                initializer: resourceValue
            })
        } else {
            declaration.addMethod({
                name: "create",
                isStatic: true,
                parameters: [{name: "construct", type: "FieldConstruct<UnreferenceableType>"}],
                statements: `return new ${className}(construct)`,
                returnType: className
            })
        }
        declaration.addConstructor({
            scope: Scope.Private,
            parameters: [{
                name: "construct",
                type: `${this.#option.construct}<${edgesUnion}>`
            }],
            statements: "super(construct)"
        })
        if (this.#option.isBox) {
            this.#imports.add(".", "BoxVisitor")
            declaration.addMethod({
                name: "accept",
                typeParameters: ["R"],
                parameters: [{name: "visitor", type: "BoxVisitor<R>"}],
                returnType: "Maybe<R>",
                statements: `return safeExecute(visitor.visit${className}, this)`
            })
        }
        declaration.addGetAccessors(this.#fieldPrinter.map(printer => ({
            name: asDefined(printer.fieldName, "accessible fields must have a name"),
            returnType: printer.type,
            statements: `return this.getField(${printer.fieldKey})`,
            docs: printer.deprecated ? ["@deprecated"] : undefined
        })))
        declaration.addMethod({
            name: "initializeFields",
            statements: `return {${this.#fieldPrinter.map(printer =>
                `${printer.fieldKey}: ${printer.new}(${printer.ctorParams.join(",")})`)}}`,
            returnType: fieldsType
        })
    }

    #fieldsTypeName(): string {return `${this.#schema.name}Fields`}

    #toValidIdentifier(identifier: string): string {
        return isValidIdentifier(identifier) ? identifier : asValidIdentifier(Strings.hyphenToCamelCase(identifier))
    }

    #printField(fieldKey: FieldKey, field: AnyField<E> | (AnyField<E> & FieldName)): Nullable<FieldPrinter> {
        const fieldName = "name" in field ? this.#toValidIdentifier(field.name) : String(fieldKey)
        if (reversed_field_names.has(fieldName)) {
            return panic(`${fieldName} is a reserved keyword`)
        }
        const pointerRules = this.#printReferencablePointerRules(field)
        const type = field.type
        const deprecated = field.deprecated === true
        switch (type) {
            case "field":
                assert(!pointerRules.isEmpty, "A field must have pointers")
                return {
                    fieldKey,
                    fieldName,
                    deprecated,
                    importPath: BOX_LIBRARY,
                    className: "Field",
                    ctorParams: [this.#writeFieldConstruct(fieldKey, fieldName, pointerRules, deprecated)],
                    new: "Field.hook",
                    type: `Field<${pointerRules.union}>`
                }
            case "int32":
                return {
                    fieldKey,
                    fieldName,
                    deprecated,
                    fieldValue: field.value,
                    importPath: BOX_LIBRARY,
                    className: "Int32Field",
                    new: "Int32Field.create",
                    type: pointerRules.isEmpty ? "Int32Field" : `Int32Field<${pointerRules.union}>`,
                    ctorParams: [this.#writeFieldConstruct(fieldKey, fieldName, pointerRules, deprecated),
                        this.#serializeConstraint(field.constraints), JSON.stringify(field.unit), field.value]
                }
            case "float32":
                return {
                    fieldKey,
                    fieldName,
                    deprecated,
                    fieldValue: field.value,
                    importPath: BOX_LIBRARY,
                    className: "Float32Field",
                    new: "Float32Field.create",
                    type: pointerRules.isEmpty ? "Float32Field" : `Float32Field<${pointerRules.union}>`,
                    ctorParams: [this.#writeFieldConstruct(fieldKey, fieldName, pointerRules, deprecated),
                        this.#serializeConstraint(field.constraints), JSON.stringify(field.unit), field.value]
                }
            case "bytes":
                return {
                    fieldKey,
                    fieldName,
                    deprecated,
                    fieldValue: field.value,
                    importPath: BOX_LIBRARY,
                    className: "ByteArrayField",
                    new: "ByteArrayField.create",
                    type: pointerRules.isEmpty ? `ByteArrayField` : `ByteArrayField<${pointerRules.union}>`,
                    ctorParams: [this.#writeFieldConstruct(fieldKey, fieldName, pointerRules, deprecated),
                        isNotUndefined(field.value)
                            ? `new Int8Array(${JSON.stringify(Array.from(field.value))})`
                            : undefined]
                }
            case "boolean":
            case "string":
                const className = asDefined(PrimitiveFields[type], `Unknown type: ${type}`)
                return {
                    fieldKey,
                    fieldName,
                    deprecated,
                    fieldValue: field.value,
                    importPath: BOX_LIBRARY,
                    className,
                    new: `${className}.create`,
                    type: pointerRules.isEmpty ? `${className}` : `${className}<${pointerRules.union}>`,
                    ctorParams: [this.#writeFieldConstruct(fieldKey, fieldName, pointerRules, deprecated),
                        type === "string" ? field.value === undefined ? "" : `"${field.value}"` : field.value]
                }
            case "pointer":
                this.#usesPointerType = true
                return {
                    fieldKey,
                    fieldName,
                    deprecated,
                    importPath: BOX_LIBRARY,
                    className: "PointerField",
                    new: "PointerField.create",
                    type: `PointerField<${(this.#generator.pointers().print(field.pointerType))}>`,
                    ctorParams: [
                        this.#writeFieldConstruct(fieldKey, fieldName, pointerRules, deprecated),
                        this.#generator.pointers().print(field.pointerType),
                        String(field.mandatory)
                    ]
                }
            case "array":
                const element = this.#printField(fieldKey, field.element)
                if (!isDefined(element)) {return null}
                this.#imports.add(element.importPath, element.className)
                const elementEdgeConstrainsPrinter = this.#printReferencablePointerRules(field.element)
                return {
                    fieldKey,
                    fieldName,
                    deprecated,
                    importPath: BOX_LIBRARY,
                    className: "ArrayField",
                    new: "ArrayField.create",
                    type: `ArrayField<${element.type}>`,
                    ctorParams: [
                        this.#writeFieldConstruct(fieldKey, fieldName, pointerRules, deprecated),
                        elementEdgeConstrainsPrinter.isEmpty
                            ? `construct => ${element.new}(${["construct",
                                ...element.ctorParams.slice(1)]})`
                            : `construct => ${element.new}(${[
                                `{...construct, ${this.#writeEdgeProperty(elementEdgeConstrainsPrinter)}}`,
                                ...element.ctorParams.slice(1)
                            ]})`,
                        field.length
                    ]
                }
            case "object": {
                this.#generator.writeClass(field.class, FieldClassOption, NoPointers)
                const className = field.class.name
                return {
                    fieldKey,
                    fieldName,
                    deprecated,
                    importPath: `./${className}`,
                    className,
                    new: `${className}.create`,
                    type: className,
                    ctorParams: [this.#writeFieldConstruct(fieldKey, fieldName, pointerRules, deprecated)]
                }
            }
            case "reserved":
                return null
            default:
                return Unhandled(type)
        }
    }

    #writeFieldConstruct(fieldKey: FieldKey,
                         fieldName: string,
                         {array, mandatory, exclusive, isEmpty}: PointerRulesPrinter,
                         deprecated: boolean): string {
        let pointerRules: string
        if (isEmpty) {
            this.#imports.add(BOX_LIBRARY, "NoPointers")
            pointerRules = "pointerRules: NoPointers"
        } else {
            pointerRules = `pointerRules: {accepts: [${array}], mandatory: ${mandatory}, exclusive: ${exclusive}}`
        }
        return `{${[`parent: this`, `fieldKey: ${fieldKey}`, `fieldName: "${fieldName}", deprecated: ${deprecated}`, pointerRules].join(",")}}`
    }

    #writeEdgeProperty({array, mandatory, exclusive, isEmpty}: PointerRulesPrinter): string {
        if (isEmpty) {
            this.#imports.add(BOX_LIBRARY, "NoPointers")
            return "pointerRules: NoPointers"
        } else {
            return `pointerRules: {accepts: [${array}], mandatory: ${mandatory}, exclusive: ${exclusive}}`
        }
    }

    #printReferencablePointerRules(maybeReferencable: Referencable<E> | AnyField<E>): PointerRulesPrinter {
        return this.#printPointerTypes("pointerRules" in maybeReferencable
            ? maybeReferencable.pointerRules
            : undefined)
    }

    #printPointerTypes(rules?: PointerRules<E>): PointerRulesPrinter {
        if (isDefined(rules) && rules.accepts.length > 0) {
            const types = rules.accepts.map(edge => this.#generator.pointers().print(edge))
            this.#usesPointerType = true
            return {
                isEmpty: false,
                union: types.join("|"),
                array: types.join(","),
                mandatory: rules.mandatory,
                exclusive: rules.exclusive === true
            }
        }
        return {isEmpty: true, union: "UnreferenceableType", array: "", mandatory: false, exclusive: false}
    }

    #writeImports(): void {
        if (this.#usesPointerType) {
            const pointers = this.#generator.pointers()
            this.#imports.add(pointers.from, pointers.enum)
        }
        this.#imports.forEach((moduleSpecifier, namedImports) => {
            if (namedImports.size > 0) {
                this.#file.addImportDeclaration({
                    moduleSpecifier, namedImports: Array.from(namedImports)
                })
            }
        })
    }

    #serializeConstraint(constraint: Constraints.Float32 | Constraints.Int32): string {
        if (typeof constraint === "string") {
            return JSON.stringify(constraint)
        }
        if ("values" in constraint) {
            return `{values: [${constraint.values.join(", ")}]}`
        }
        const entries = Object.entries(constraint).map(([key, value]) => {
            let serializedValue: string
            if (typeof value === "string") {
                serializedValue = JSON.stringify(value)
            } else if (value === Number.NEGATIVE_INFINITY) {
                serializedValue = "Number.NEGATIVE_INFINITY"
            } else if (value === Number.POSITIVE_INFINITY) {
                serializedValue = "Number.POSITIVE_INFINITY"
            } else {
                serializedValue = String(value)
            }
            return `${key}: ${serializedValue}`
        })
        return `{${entries.join(", ")}}`
    }
}