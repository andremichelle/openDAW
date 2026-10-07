export type ParameterTree<T> = {
    groups: Array<{ label: string, tree: ParameterTree<T> }>
    items: Array<{ label: string, value: T }>
}

type Entry<T> = { words: ReadonlyArray<string>, name: string, value: T }

// CLAP module paths first ("osc/a"), then the shared leading words of the parameter names
export namespace WclapParameterTree {
    export const build = <T>(parameters: ReadonlyArray<{ module: string, name: string, value: T }>): ParameterTree<T> => {
        const modules = new Map<string, Array<{ module: ReadonlyArray<string>, name: string, value: T }>>()
        const local: Array<Entry<T>> = []
        for (const {module, name, value} of parameters) {
            const path = module.split("/").filter(segment => segment.length > 0)
            if (path.length === 0) {
                local.push({words: words(name), name, value})
            } else {
                const list = modules.get(path[0]) ?? []
                list.push({module: path.slice(1), name, value})
                modules.set(path[0], list)
            }
        }
        const byWords = byBeginning(local)
        return {
            groups: [
                ...Array.from(modules, ([label, members]) => ({
                    label, tree: build(members.map(({module, name, value}) => ({module: module.join("/"), name, value})))
                })),
                ...byWords.groups
            ],
            items: byWords.items
        }
    }

    const words = (name: string): ReadonlyArray<string> => name.split(/\s+/).filter(word => word.length > 0)

    // a first word shared by two or more names, at least one of them longer, becomes a group of the remainders
    const byBeginning = <T>(entries: ReadonlyArray<Entry<T>>): ParameterTree<T> => {
        const byFirst = new Map<string, Array<Entry<T>>>()
        entries.filter(({words}) => words.length > 0).forEach(entry => {
            const members = byFirst.get(entry.words[0]) ?? []
            members.push(entry)
            byFirst.set(entry.words[0], members)
        })
        const isGroup = (members: ReadonlyArray<Entry<T>>): boolean =>
            members.length > 1 && members.some(({words}) => words.length > 1)
        const groups = Array.from(byFirst)
            .filter(([, members]) => isGroup(members))
            .map(([label, members]) =>
                collapse(label, byBeginning(members.map(entry => ({...entry, words: entry.words.slice(1)})))))
        const items = entries
            .filter(({words}) => words.length === 0 || !isGroup(byFirst.get(words[0]) ?? []))
            .map(({words, name, value}) => ({label: words.length === 0 ? name : words.join(" "), value}))
        return {groups, items}
    }

    // a group holding nothing but one sub group becomes one level: "Osc" > "A" > ... reads "Osc A" > ...
    const collapse = <T>(label: string, tree: ParameterTree<T>): { label: string, tree: ParameterTree<T> } => {
        if (tree.items.length > 0 || tree.groups.length !== 1) {return {label, tree}}
        const [only] = tree.groups
        return {label: `${label} ${only.label}`, tree: only.tree}
    }
}
