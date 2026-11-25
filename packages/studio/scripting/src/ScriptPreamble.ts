export namespace ScriptPreamble {
    // a script may start with imports for type checks in a local editor, the code starts at the first comment
    export const strip = (source: string): string => {
        if (!/^\s*import\s/.test(source)) {return source}
        const start = source.indexOf("//")
        return start === -1 ? "" : source.substring(start)
    }
}
