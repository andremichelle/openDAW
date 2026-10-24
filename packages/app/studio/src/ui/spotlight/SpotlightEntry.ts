import {int, Option} from "@opendaw/lib-std"
import {IconSymbol} from "@opendaw/studio-enums"
import {SpotlightVerb, SpotlightVerbs} from "@/ui/spotlight/SpotlightVerbs"

export type SpotlightEntry = {
    readonly verb: SpotlightVerb
    readonly label: string
    readonly names: ReadonlyArray<string>
    readonly qualifiers: ReadonlyArray<string>
    readonly icon: IconSymbol
    readonly detail: string
    readonly group: int
    readonly disabled: Option<string>
    readonly children: ReadonlyArray<SpotlightEntry>
    readonly run: () => void
}

export namespace SpotlightEntry {
    const words = (text: string): ReadonlyArray<string> =>
        text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 0)

    // tiers: 3 exact, 2 name start, 1 word starts (plus name hits), 0 spaceless, -1 none; qualifiers only narrow
    export const score = (entry: SpotlightEntry, subject: string): int => {
        const queryWords = words(subject)
        if (queryWords.length === 0) {return -1}
        const nameWords = entry.names.flatMap(words)
        const allWords = [...nameWords, ...entry.qualifiers.flatMap(words)]
        const startsAll = queryWords.every(query => allWords.some(word => word.startsWith(query)))
        const nameHits = queryWords.filter(query => nameWords.some(word => word.startsWith(query))).length
        if (startsAll && nameHits > 0) {
            const tier = queryWords.every(query => allWords.includes(query)) ? 3
                : queryWords.some(query => nameWords[0].startsWith(query)) ? 2 : 1
            return tier * 64 + nameHits
        }
        const compact = queryWords.join("")
        return entry.names.some(name => words(name).some((_, index, all) =>
            all.slice(index).join("").startsWith(compact))) ? 0 : -1
    }

    const disabledLast = (a: SpotlightEntry, b: SpotlightEntry): int =>
        Number(a.disabled.nonEmpty()) - Number(b.disabled.nonEmpty())

    const compare = (a: SpotlightEntry, b: SpotlightEntry): int =>
        disabledLast(a, b) || a.group - b.group || a.label.localeCompare(b.label)

    const ranked = (entries: ReadonlyArray<SpotlightEntry>, subject: string): ReadonlyArray<SpotlightEntry> => entries
        .map(entry => ({entry, score: score(entry, subject)}))
        .filter(({score}) => score >= 0)
        .toSorted((a, b) => disabledLast(a.entry, b.entry) || b.score - a.score || compare(a.entry, b.entry))
        .map(({entry}) => entry)

    export const rank = (entries: ReadonlyArray<SpotlightEntry>, verb: Option<SpotlightVerb>, subject: string): ReadonlyArray<SpotlightEntry> =>
        ranked(verb.match({none: () => entries.filter(entry => !SpotlightVerbs.Explicit.includes(entry.verb)), some: only => entries.filter(entry => entry.verb === only)}), subject)

    export const frequent = (entries: ReadonlyArray<SpotlightEntry>, verb: SpotlightVerb,
                             usage: (entry: SpotlightEntry) => int): ReadonlyArray<SpotlightEntry> => entries
        .filter(entry => entry.verb === verb)
        .toSorted((a, b) => disabledLast(a, b) || usage(b) - usage(a) || compare(a, b))

    // inside a scope an empty subject lists every child
    export const browse = (entries: ReadonlyArray<SpotlightEntry>, subject: string): ReadonlyArray<SpotlightEntry> =>
        words(subject).length === 0 ? entries.toSorted(compare) : ranked(entries, subject)
}
