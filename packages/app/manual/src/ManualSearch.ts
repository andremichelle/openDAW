import type {ManualPageEntry} from "./Manuals"

export namespace ManualSearch {
    export type Texts = Readonly<Record<string, string>>

    export const normalize = (markdown: string): string => markdown
        .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
        .replace(/<\/?[a-z][^>]*>/gi, " ")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()

    export const pathOf = (file: string): string => file === "index" ? "/manuals/" : `/manuals/${file}`

    export const find = (pages: ReadonlyArray<ManualPageEntry>, texts: Texts, query: string): ReadonlyArray<ManualPageEntry> => {
        const words = normalize(query).split(" ").filter(word => word.length > 0)
        if (words.length === 0) {return []}
        const unique = pages.filter((page, index) => pages.findIndex(other => other.path === page.path) === index)
        const matches = (text: string) => words.every(word => text.includes(word))
        const byLabel = unique.filter(page => matches(normalize(page.label)))
        const byText = unique.filter(page => !byLabel.includes(page) && matches(texts[page.path] ?? ""))
        return [...byLabel, ...byText]
    }
}
