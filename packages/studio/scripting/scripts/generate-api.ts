import * as ts from "typescript"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface GeneratorOptions {
    inputFile: string
    outputFile: string
    rootDir: string
}

export function generateFlattenedDeclarations(options: GeneratorOptions): void {
    const { inputFile, outputFile, rootDir } = options

    const visited = new Set<string>()
    const output: string[] = []

    const packageMap = findAllPackages(rootDir)

    function findAllPackages(rootDir: string): Map<string, string> {
        const packages = new Map<string, string>()

        function searchDir(dir: string) {
            if (!fs.existsSync(dir)) return

            const packageJsonPath = path.join(dir, 'package.json')
            if (fs.existsSync(packageJsonPath)) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
                    if (pkg.name) {
                        packages.set(pkg.name, dir)
                    }
                } catch (e) {
                    // Invalid package.json
                }
            }

            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true })
                for (const entry of entries) {
                    if (entry.isDirectory() &&
                        entry.name !== 'node_modules' &&
                        entry.name !== 'dist' &&
                        entry.name !== 'build' &&
                        !entry.name.startsWith('.')) {
                        searchDir(path.join(dir, entry.name))
                    }
                }
            } catch (e) {
                // Permission error
            }
        }

        const packagesDir = path.join(rootDir, 'packages')
        if (fs.existsSync(packagesDir)) {
            searchDir(packagesDir)
        }

        return packages
    }

    function resolveImportPath(importPath: string, currentFile: string): string | null {
        const currentDir = path.dirname(currentFile)

        if (importPath.startsWith('.')) {
            const resolved = path.resolve(currentDir, importPath)
            if (fs.existsSync(resolved + '.d.ts')) return resolved + '.d.ts'
            if (fs.existsSync(resolved + '.ts')) return resolved + '.ts'
            if (fs.existsSync(path.join(resolved, 'index.d.ts'))) {
                return path.join(resolved, 'index.d.ts')
            }
            if (fs.existsSync(path.join(resolved, 'index.ts'))) {
                return path.join(resolved, 'index.ts')
            }
        }

        const packagePath = packageMap.get(importPath)
        if (packagePath) {
            return tryResolvePackage(packagePath)
        }

        const nodeModulesPath = path.join(rootDir, 'node_modules', importPath)
        return tryResolvePackage(nodeModulesPath)
    }

    function tryResolvePackage(packagePath: string): string | null {
        if (!fs.existsSync(packagePath)) return null

        const packageJsonPath = path.join(packagePath, 'package.json')
        if (fs.existsSync(packageJsonPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
                const types = pkg.types || pkg.typings || pkg.exports?.['.']?.types
                if (types) {
                    const typesPath = path.join(packagePath, types)
                    if (fs.existsSync(typesPath)) return typesPath
                }

                if (pkg.main) {
                    const mainDts = path.join(packagePath, pkg.main.replace(/\.js$/, '.d.ts'))
                    if (fs.existsSync(mainDts)) return mainDts
                }
            } catch (e) {
                // Invalid package.json
            }
        }

        const candidates = [
            path.join(packagePath, 'dist', 'index.d.ts'),
            path.join(packagePath, 'build', 'index.d.ts'),
            path.join(packagePath, 'src', 'index.ts'),
            path.join(packagePath, 'src', 'index.d.ts'),
            path.join(packagePath, 'index.d.ts'),
            path.join(packagePath, 'index.ts'),
        ]

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate
        }

        return null
    }

    function extractTypeReferences(node: ts.Node): Set<string> {
        const typeRefs = new Set<string>()

        function visit(node: ts.Node) {
            // Type reference: Foo, Bar<T>, etc.
            if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
                typeRefs.add(node.typeName.text)
            }

            // Continue traversing
            ts.forEachChild(node, visit)
        }

        visit(node)
        return typeRefs
    }

    function getExportedNames(filePath: string, importNames: Set<string>): Map<string, { node: ts.Node, sourceFile: ts.SourceFile }> {

        const sourceText = fs.readFileSync(filePath, 'utf-8')
        const sourceFile = ts.createSourceFile(
            filePath,
            sourceText,
            ts.ScriptTarget.Latest,
            true
        )

        const exports = new Map<string, { node: ts.Node, sourceFile: ts.SourceFile }>()

        // Collect all imported names from this file
        const importedNames = new Set<string>()
        sourceFile.statements.forEach(statement => {
            if (ts.isImportDeclaration(statement)) {
                const importClause = statement.importClause
                if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
                    importClause.namedBindings.elements.forEach(element => {
                        importedNames.add(element.name.text)
                    })
                }
            }
        })


        // Find requested exports and collect their type dependencies
        const additionalTypesToFind = new Set<string>()

        sourceFile.statements.forEach(statement => {
            if (hasExportModifier(statement)) {
                const name = getDeclarationName(statement)
                if (name && importNames.has(name)) {
                    exports.set(name, { node: statement, sourceFile })

                    // Extract type dependencies that are imported
                    const typeRefs = extractTypeReferences(statement)
                    typeRefs.forEach(ref => {
                        if (importedNames.has(ref) && !importNames.has(ref) && !exports.has(ref)) {
                            additionalTypesToFind.add(ref)
                        }
                    })
                }
            }

            if (ts.isExportDeclaration(statement)) {
                // Handle: export * from './module'
                if (!statement.exportClause && statement.moduleSpecifier) {
                    const moduleSpec = (statement.moduleSpecifier as ts.StringLiteral).text
                    const reExportPath = resolveImportPath(moduleSpec, filePath)
                    if (reExportPath) {
                        const reExports = getExportedNames(reExportPath, importNames)
                        reExports.forEach((data, name) => {
                            exports.set(name, data) // Keep the original sourceFile
                        })
                    }
                }
                // Handle: export { X, Y } from './module'
                else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                    statement.exportClause.elements.forEach(element => {
                        const exportName = element.name.text
                        if (importNames.has(exportName)) {
                            if (statement.moduleSpecifier) {
                                const moduleSpec = (statement.moduleSpecifier as ts.StringLiteral).text
                                const reExportPath = resolveImportPath(moduleSpec, filePath)
                                if (reExportPath) {
                                    const reExports = getExportedNames(reExportPath, new Set([exportName]))
                                    reExports.forEach((data, name) => exports.set(name, data))
                                }
                            } else {
                                const originalName = element.propertyName?.text || exportName
                                sourceFile.statements.forEach(stmt => {
                                    const declName = getDeclarationName(stmt)
                                    if (declName === originalName) {
                                        exports.set(exportName, { node: stmt, sourceFile })
                                    }
                                })
                            }
                        }
                    })
                }
            }
        })

        // Recursively fetch the additional types we found
        if (additionalTypesToFind.size > 0) {
            const moreExports = getExportedNames(filePath, additionalTypesToFind)
            moreExports.forEach((data, name) => exports.set(name, data))
        }

        return exports
    }

    function getDeclarationName(node: ts.Node): string | null {
        if (ts.isVariableStatement(node)) {
            const declaration = node.declarationList.declarations[0]
            if (ts.isIdentifier(declaration.name)) {
                return declaration.name.text
            }
        }
        if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
            ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
            return node.name?.getText() || null
        }
        return null
    }

    function processFile(filePath: string): void {
        if (visited.has(filePath)) return
        visited.add(filePath)

        const sourceText = fs.readFileSync(filePath, 'utf-8')
        const sourceFile = ts.createSourceFile(
            filePath,
            sourceText,
            ts.ScriptTarget.Latest,
            true
        )

        const reExportedNames = new Set<string>()

        // Track where each import comes from
        const importSources = new Map<string, string>() // name -> resolved file path

        sourceFile.statements.forEach(statement => {
            if (ts.isImportDeclaration(statement)) {
                const moduleSpecifier = (statement.moduleSpecifier as ts.StringLiteral).text
                const resolvedPath = resolveImportPath(moduleSpecifier, filePath)

                if (resolvedPath) {
                    const importClause = statement.importClause
                    if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
                        importClause.namedBindings.elements.forEach(element => {
                            importSources.set(element.name.text, resolvedPath)
                        })
                    }
                }
            }

            if (ts.isExportDeclaration(statement)) {
                if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                    statement.exportClause.elements.forEach(element => {
                        reExportedNames.add(element.name.text)
                    })
                }
            }
        })


        // Collect all type dependencies needed
        const typeDependencies = new Map<string, string>() // name -> source file

        sourceFile.statements.forEach(statement => {
            if (hasExportModifier(statement)) {
                const name = getDeclarationName(statement)
                if (name) {
                    // Extract type dependencies
                    const typeRefs = extractTypeReferences(statement)
                    typeRefs.forEach(ref => {
                        if (importSources.has(ref)) {
                            typeDependencies.set(ref, importSources.get(ref)!)
                        }
                    })
                }
            }
        })


        // Fetch type dependencies from their source files
        typeDependencies.forEach((sourceFilePath, typeName) => {
            const result = getExportedNames(sourceFilePath, new Set([typeName]))
            const printer = ts.createPrinter()

            result.forEach(({ node, sourceFile }) => {
                const modifiedNode = removeExportModifier(node)
                const printed = printer.printNode(
                    ts.EmitHint.Unspecified,
                    modifiedNode,
                    sourceFile
                )
                output.push(printed)
            })
        })

        // Process re-exported items
        sourceFile.statements.forEach(statement => {
            if (ts.isImportDeclaration(statement)) {
                const moduleSpecifier = (statement.moduleSpecifier as ts.StringLiteral).text
                const resolvedPath = resolveImportPath(moduleSpecifier, filePath)

                if (!resolvedPath) {
                    console.warn(`Could not resolve import: ${moduleSpecifier}`)
                    return
                }

                const importClause = statement.importClause
                if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
                    const importedNames = new Set<string>()

                    importClause.namedBindings.elements.forEach(element => {
                        const importName = element.name.text
                        if (reExportedNames.has(importName)) {
                            importedNames.add(importName)
                        }
                    })

                    if (importedNames.size > 0) {
                        const result = getExportedNames(resolvedPath, importedNames)
                        const printer = ts.createPrinter()

                        result.forEach(({ node, sourceFile }) => {
                            const modifiedNode = removeExportModifier(node)
                            const printed = printer.printNode(
                                ts.EmitHint.Unspecified,
                                modifiedNode,
                                sourceFile
                            )
                            output.push(printed)
                        })
                    }
                }
            }
        })

        // Output declarations from this file
        sourceFile.statements.forEach(statement => {
            if (ts.isImportDeclaration(statement)) return
            if (ts.isExportDeclaration(statement)) return

            if (hasExportModifier(statement)) {
                const printer = ts.createPrinter()
                const modifiedNode = removeExportModifier(statement)
                const printed = printer.printNode(
                    ts.EmitHint.Unspecified,
                    modifiedNode,
                    sourceFile
                )
                output.push(printed)
            }
        })
    }

    function hasExportModifier(node: ts.Node): boolean {
        if (!ts.canHaveModifiers(node)) return false
        const modifiers = ts.getModifiers(node)
        return modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false
    }

    function removeExportModifier(node: ts.Node): ts.Node {
        if (!ts.canHaveModifiers(node)) return node
        const modifiers = ts.getModifiers(node)
        if (!modifiers) return node

        const newModifiers = modifiers.filter(mod => mod.kind !== ts.SyntaxKind.ExportKeyword)

        if (ts.isVariableStatement(node)) {
            return ts.factory.updateVariableStatement(node, newModifiers, node.declarationList)
        }
        if (ts.isFunctionDeclaration(node)) {
            return ts.factory.updateFunctionDeclaration(
                node,
                newModifiers,
                node.asteriskToken,
                node.name,
                node.typeParameters,
                node.parameters,
                node.type,
                node.body
            )
        }
        if (ts.isClassDeclaration(node)) {
            return ts.factory.updateClassDeclaration(
                node,
                newModifiers,
                node.name,
                node.typeParameters,
                node.heritageClauses,
                node.members
            )
        }
        if (ts.isInterfaceDeclaration(node)) {
            return ts.factory.updateInterfaceDeclaration(
                node,
                newModifiers,
                node.name,
                node.typeParameters,
                node.heritageClauses,
                node.members
            )
        }
        if (ts.isTypeAliasDeclaration(node)) {
            return ts.factory.updateTypeAliasDeclaration(
                node,
                newModifiers,
                node.name,
                node.typeParameters,
                node.type
            )
        }
        if (ts.isEnumDeclaration(node)) {
            return ts.factory.updateEnumDeclaration(
                node,
                newModifiers,
                node.name,
                node.members
            )
        }
        if (ts.isModuleDeclaration(node)) {
            return ts.factory.updateModuleDeclaration(
                node,
                newModifiers,
                node.name,
                node.body
            )
        }

        return node
    }

    processFile(path.resolve(rootDir, inputFile))

    output.push('declare const openDAW: Api')
    output.push('declare const sampleRate: number')

    fs.writeFileSync(outputFile, output.join('\n\n'))
    console.log(`\nGenerated flattened declarations: ${outputFile}`)
}

function findMonorepoRoot(startDir: string): string {
    let currentDir = startDir
    while (currentDir !== path.dirname(currentDir)) {
        const packagesDir = path.join(currentDir, 'packages')
        if (fs.existsSync(packagesDir)) {
            return currentDir
        }
        currentDir = path.dirname(currentDir)
    }
    return startDir
}

const monorepoRoot = findMonorepoRoot(__dirname)

const scriptDir = path.dirname(__filename)

generateFlattenedDeclarations({
    inputFile: path.resolve(scriptDir, '../src/Api.ts'),
    outputFile: path.resolve(scriptDir, '../src/api.declaration.d.ts'),
    rootDir: monorepoRoot
})