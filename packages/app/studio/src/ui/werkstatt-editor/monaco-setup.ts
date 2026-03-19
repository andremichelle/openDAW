import "@/monaco/imports"
import * as monaco from "monaco-editor"
import "monaco-editor/esm/vs/language/typescript/monaco.contribution"
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution"
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard"

monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false
})

monaco.languages.typescript.javascriptDefaults.addExtraLib(`
/** Audio sample rate in Hz (e.g. 44100 or 48000) */
declare const sampleRate: number;
`, "ts:werkstatt-globals.d.ts")

export {monaco}
export type Monaco = typeof monaco
