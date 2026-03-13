import "@/monaco/imports"
import * as monaco from "monaco-editor"
import "monaco-editor/esm/vs/language/typescript/monaco.contribution"
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution"
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard"

monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false
})

export {monaco}
export type Monaco = typeof monaco
