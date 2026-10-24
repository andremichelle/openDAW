import {Option} from "@opendaw/lib-std"
import {IconSymbol} from "@opendaw/studio-enums"

export type SpotlightVerb = "create" | "open" | "goto" | "remove" | "move" | "edit"

export type SpotlightVerbDefinition = {
    readonly verb: SpotlightVerb
    readonly word: string
    readonly symbol: string
    readonly icon: IconSymbol
}

export type SpotlightQuery = {
    readonly verb: Option<SpotlightVerbDefinition>
    readonly subject: string
    readonly completion: Option<string>
}

export namespace SpotlightVerbs {
    export const List: ReadonlyArray<SpotlightVerbDefinition> = [
        {verb: "create", word: "create", symbol: "+", icon: IconSymbol.Add},
        {verb: "open", word: "open", symbol: "/", icon: IconSymbol.FolderOpen},
        {verb: "goto", word: "goto", symbol: "@", icon: IconSymbol.Search},
        {verb: "remove", word: "remove", symbol: "-", icon: IconSymbol.Delete},
        {verb: "move", word: "move", symbol: ">", icon: IconSymbol.ArrowRight},
        {verb: "edit", word: "edit", symbol: "=", icon: IconSymbol.Pencil}
    ]

    const byWordPrefix = (prefix: string): Option<SpotlightVerbDefinition> => {
        if (prefix.length === 0) {return Option.None}
        const candidates = List.filter(({word}) => word.startsWith(prefix))
        return candidates.length === 1 ? Option.wrap(candidates[0]) : Option.None
    }

    export const lead = (text: string): Option<{ verb: SpotlightVerbDefinition, rest: string }> => {
        const query = text.trimStart()
        const lower = query.toLowerCase()
        return Option.wrap(List.find(({symbol, word}) =>
            query.startsWith(symbol) || (lower.startsWith(word) && /\s/.test(query.charAt(word.length)))))
            .map(verb => ({
                verb, rest: query.slice(query.startsWith(verb.symbol) ? verb.symbol.length : verb.word.length).trimStart()
            }))
    }

    export const parse = (text: string): SpotlightQuery => {
        const query = text.trimStart()
        const implicit: SpotlightQuery = {verb: Option.None, subject: query.trim(), completion: Option.None}
        return Option.wrap(List.find(({symbol}) => query.startsWith(symbol))).match({
            some: verb => ({verb: Option.wrap(verb), subject: query.slice(verb.symbol.length).trim(), completion: Option.None}),
            none: () => {
                const space = query.search(/\s/)
                if (space === -1) {
                    return {...implicit, completion: byWordPrefix(query.toLowerCase()).map(({word}) => `${word} `)}
                }
                return byWordPrefix(query.slice(0, space).toLowerCase()).match({
                    none: () => implicit,
                    some: verb => ({verb: Option.wrap(verb), subject: query.slice(space).trim(), completion: Option.None})
                })
            }
        })
    }
}
