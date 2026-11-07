// Blanks every user-given name (projects, tracks, devices, samples, soundfonts, presets, ...) in error reports.
export namespace ReportScrubber {
    export const Placeholder = "<name>"

    export const scrubber = (names: ReadonlyArray<string>): (text: string) => string => {
        if (names.length === 0) {return text => text}
        const alternatives = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, "gu")
        return text => text.replace(pattern, Placeholder)
    }
}
