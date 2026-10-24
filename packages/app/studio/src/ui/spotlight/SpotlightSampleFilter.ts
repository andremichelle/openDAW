import {Option} from "@opendaw/lib-std"
import {SpotlightEntry} from "@/ui/spotlight/SpotlightEntry"

export namespace SpotlightSampleFilter {
    export const Loop = "loop"
    export const OneShot = "oneshot"

    export const narrow = (entries: ReadonlyArray<SpotlightEntry>, subject: string)
        : { entries: ReadonlyArray<SpotlightEntry>, subject: string } => {
        const words = subject.split(/\s+/).filter(word => word.length > 0)
        const lower = words.map(word => word.toLowerCase())
        const kind: Option<string> = lower.some(word => word === "noloop" || word === OneShot) ? Option.wrap(OneShot)
            : lower.includes(Loop) ? Option.wrap(Loop) : Option.None
        return kind.match({
            none: () => ({entries, subject}),
            some: kind => ({
                entries: entries.filter(entry => entry.verb !== "sample" || entry.qualifiers.includes(kind)),
                subject: words.filter(word => ![Loop, OneShot, "noloop"].includes(word.toLowerCase())).join(" ")
            })
        })
    }
}
