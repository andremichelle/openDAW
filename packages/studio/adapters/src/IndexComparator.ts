import {Comparator, int, panic} from "@moises-ai/lib-std"

export const IndexComparator: Comparator<int> = (a: int, b: int): int => {
    if (a === b) {return 0}
    const difference: int = a - b
    if (difference === 0) {
        return panic(`Indices cannot be equal (${a}, ${b})`)
    }
    return difference
}