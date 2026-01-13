import {Func, Terminable} from "@moises-ai/lib-std"

export namespace TerminatorUtils {
    const weakRefs = new Array<[WeakRef<WeakKey>, Terminable]>()
    /**
     * Terminates if the key is no longer referenced to.
     * Make sure that the Terminable does not include other references
     * that would prevent the key from being gc collected.
     * That means the key must not appear in the Terminable!
     * @param key WeakKey
     * @param subscribe Sends a WeakRef to be able to be gc collected
     */
    export const watchWeak = <K extends WeakKey>(key: K, subscribe: Func<WeakRef<K>, Terminable>): K => {
        const weakRef = new WeakRef(key)
        const terminable = subscribe(weakRef)
        weakRefs.push([weakRef, terminable])
        if (weakRefs.length === 1) {
            startWatchWeak()
        }
        return key
    }

    const startWatchWeak = (): void => {
        console.debug("start weak watching")
        const id = setInterval(() => {
            let index = weakRefs.length
            while (--index >= 0) {
                const entry = weakRefs[index]
                if (entry[0].deref() === undefined) {
                    entry[1].terminate()
                    weakRefs.splice(index, 1)
                    if (weakRefs.length === 0) {
                        clearInterval(id)
                    }
                }
            }
        }, 1000)
    }
}