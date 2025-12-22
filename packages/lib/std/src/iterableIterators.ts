export namespace IterableIterators {
    export function* empty<T>(): IterableIterator<T> {return}

    export function* flatten<T>(...generators: Iterable<T>[]): IterableIterator<T> {
        for (const generator of generators) {
            for (const value of generator) {
                yield value
            }
        }
    }
}