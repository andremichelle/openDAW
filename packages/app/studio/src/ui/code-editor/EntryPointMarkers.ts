import type * as MonacoEditor from "monaco-editor"
import {isDefined, Lifecycle, Terminable} from "@opendaw/lib-std"
import {ScriptEntryPoints, ScriptTopLevel} from "@opendaw/studio-adapters"

type Monaco = typeof MonacoEditor

const OWNER = "script-entry-points"

const describe = ({signature, documentation}: ScriptEntryPoints.Entry): MonacoEditor.IMarkdownString =>
    ({value: `\`\`\`js\n${signature}\n\`\`\`\n${documentation}`})

export namespace EntryPointMarkers {
    export const install = (monaco: Monaco,
                            editor: MonacoEditor.editor.IStandaloneCodeEditor,
                            model: MonacoEditor.editor.ITextModel,
                            api: ScriptEntryPoints.Api,
                            lifecycle: Lifecycle): void => {
        const decorations = editor.createDecorationsCollection()
        const rangeOf = ({offset, name}: ScriptEntryPoints.Finding): MonacoEditor.IRange => {
            const start = model.getPositionAt(offset)
            const end = model.getPositionAt(offset + name.length)
            return {startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column}
        }
        const topLevelMarkers = (code: string): ReadonlyArray<MonacoEditor.editor.IMarkerData> => {
            if (!ScriptTopLevel.applies(code)) {return []}
            return ScriptTopLevel.check(code).violations.map(({offset, message}) => {
                const {lineNumber, column} = model.getPositionAt(offset)
                return {startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber,
                    endColumn: model.getLineMaxColumn(lineNumber), severity: monaco.MarkerSeverity.Error, message}
            })
        }
        const update = (): void => {
            const code = model.getValue()
            const findings = ScriptEntryPoints.analyse(code, api)
            decorations.set(findings.map(finding => ({
                range: rangeOf(finding),
                options: {
                    inlineClassName: finding.type === "known" ? "script-entry-point" : null,
                    hoverMessage: describe(finding.entry)
                }
            })))
            monaco.editor.setModelMarkers(model, OWNER, [
                ...findings.flatMap(finding => isDefined(finding.warning)
                    ? [{...rangeOf(finding), severity: monaco.MarkerSeverity.Warning, message: finding.warning}]
                    : []),
                ...topLevelMarkers(code)
            ])
        }
        const subscription = model.onDidChangeContent(update)
        update()
        lifecycle.own(Terminable.create(() => {
            subscription.dispose()
            decorations.clear()
            monaco.editor.setModelMarkers(model, OWNER, [])
        }))
    }
}
