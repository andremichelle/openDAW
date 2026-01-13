import "@/monaco/imports"
import * as monaco from "monaco-editor"
import "monaco-editor/esm/vs/language/typescript/monaco.contribution"
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution"
import declarations from "@moises-ai/studio-scripting/api.declaration?raw"
import library from "@moises-ai/studio-scripting/library?raw"

// Configure TypeScript defaults
const tsDefaults = monaco.languages.typescript.typescriptDefaults

tsDefaults.setEagerModelSync(true)

tsDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowJs: true,
    noLib: true,
    checkJs: false,
    strict: true,
    jsx: monaco.languages.typescript.JsxEmit.Preserve,
    noEmit: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true
})

tsDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
    onlyVisible: false,
    diagnosticCodesToIgnore: []
})

tsDefaults.addExtraLib(library, "file:///library.d.ts")
tsDefaults.addExtraLib(declarations, "ts:opendaw.d.ts")
tsDefaults.addExtraLib(`
declare const console: Console
declare const Math: Math
`, "ts:libs.d.ts")

export {monaco}
export type Monaco = typeof monaco