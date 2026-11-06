// Blanks every user-given name (projects, tracks, devices, samples, soundfonts, presets, ...) in error reports.
export namespace ReportScrubber {
    export const Placeholder = "<name>"

    export const scrubber = (names: ReadonlyArray<string>): (text: string) => string => {
        if (names.length === 0) {return text => text}
        const pattern = new RegExp(names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
        return text => text.replace(pattern, Placeholder)
    }
}
