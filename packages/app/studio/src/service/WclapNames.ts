// The plugins of one bundle often repeat a shared tag ("[Basics] Reverb", "[Basics] Chorus"), strip it
export namespace WclapNames {
    const isWordCharacter = (char: string): boolean => /[\p{L}\p{N}]/u.test(char)

    export const distinct = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
        if (names.length < 2) {return names}
        const shortest = names.reduce((min, name) => name.length < min.length ? name : min)
        const common = Array.from(shortest).findIndex((char, index) => names.some(name => name[index] !== char))
        const prefix = shortest.substring(0, common === -1 ? shortest.length : common)
        const cut = Array.from(prefix).findLastIndex(char => !isWordCharacter(char)) + 1
        if (cut === 0) {return names}
        const stripped = names.map(name => name.substring(cut).replace(/^[^\p{L}\p{N}]+/u, ""))
        return stripped.some(name => name.length === 0) ? names : stripped
    }
}
