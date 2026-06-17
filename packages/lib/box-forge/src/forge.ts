import {isDefined, Maybe} from "@opendaw/lib-std"
import {NoPointers, PointerRules, PointerTypes} from "@opendaw/lib-box"
import {ModuleDeclarationKind, Project, SourceFile, VariableDeclarationKind} from "ts-morph"
import {BoxSchema, ClassSchema, ResourceType, Schema} from "./schema"
import {header} from "./header"
import {BOX_LIBRARY, BoxClassOption, ClassOptions, ClassWriter, STD_LIBRARY} from "./ts-class-writer"
import {writeRustRegistry} from "./rust-registry"

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
        if (isDefined(schema.rust)) {
            writeRustRegistry(schema, schema.rust.path)
        }
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

    writeClass(schema: ClassSchema<E>,
               option: ClassOptions,
               pointerRules: PointerRules<E>,
               resource?: ResourceType,
               ephemeral?: boolean,
               tags?: Record<string, string | number | boolean>): void {
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
        ClassWriter.write(this, file, schema, option, pointerRules, resource, ephemeral, tags)
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
            this.writeClass(box.class, BoxClassOption, box.pointerRules ?? NoPointers, box.resource, box.ephemeral, box.tags))
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
                name: "names",
                type: "ReadonlyArray<keyof TypeMap>",
                initializer: `[${boxes.map(({class: {name}}) => `"${name}"`).join(", ")}]`
            }]
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