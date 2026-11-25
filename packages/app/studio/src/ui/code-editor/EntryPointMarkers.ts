import type * as MonacoEditor from "monaco-editor"
import {Func, isDefined, Lifecycle, Terminable, tryCatch} from "@opendaw/lib-std"
import {ScriptDeclaration, ScriptEntryPoints, ScriptTopLevel, ScriptViewLayout} from "@opendaw/studio-adapters"

type Monaco = typeof MonacoEditor

const OWNER = "script-entry-points"

const describe = ({signature, documentation}: ScriptEntryPoints.Entry): MonacoEditor.IMarkdownString =>
    ({value: `\`\`\`js\n${signature}\n\`\`\`\n${documentation}`})

export namespace EntryPointMarkers {
    export const install = (monaco: Monaco,
                            editor: MonacoEditor.editor.IStandaloneCodeEditor,
                            model: MonacoEditor.editor.ITextModel,
                            api: ScriptEntryPoints.Api,
                            viewApi: Func<string, ScriptEntryPoints.Api>,
                            lifecycle: Lifecycle): void => {
        const decorations = editor.createDecorationsCollection()
        const rangeOf = ({offset, name}: ScriptEntryPoints.Finding): MonacoEditor.IRange => {
            const start = model.getPositionAt(offset)
            const end = model.getPositionAt(offset + name.length)
            return {startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column}
        }
        const viewClasses = (code: string): ReadonlyArray<string> => {
            const result = tryCatch(() => [...ScriptDeclaration.parseViews(code), ...ScriptDeclaration.parseWindows(code)])
            return result.status === "success" ? Array.from(new Set(result.value.map(({className}) => className))) : []
        }
        const lineMarker = (offset: number, message: string, severity: MonacoEditor.MarkerSeverity): MonacoEditor.editor.IMarkerData => {
            const {lineNumber, column} = model.getPositionAt(offset)
            return {startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber,
                endColumn: model.getLineMaxColumn(lineNumber), severity, message}
        }
        const topLevelMarkers = (code: string): ReadonlyArray<MonacoEditor.editor.IMarkerData> => {
            if (!ScriptTopLevel.applies(code)) {return []}
            return ScriptTopLevel.check(code).violations
                .map(({offset, message}) => lineMarker(offset, message, monaco.MarkerSeverity.Error))
        }
        const update = (): void => {
            const code = model.getValue()
            const findings = Array.from(new Map([api, ...viewClasses(code).map(viewApi)]
                .flatMap(classApi => ScriptEntryPoints.analyse(code, classApi))
                .map(finding => [`${finding.offset}:${finding.type}`, finding])).values())
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
                ...topLevelMarkers(code),
                ...ScriptViewLayout.issues(code).map(({offset, message}) => lineMarker(offset, message, monaco.MarkerSeverity.Warning))
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
