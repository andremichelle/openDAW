import {Subscription, Terminable} from "./terminable"
import {Notifier} from "./notifier"
import {PathTuple, ValueAtPath} from "./lang"
import {Observer} from "./observers"

export class VirtualObject<T extends object> implements Terminable {
    readonly #notifier = new Notifier<keyof T>()
    readonly #data: T
    readonly #proxy: T

    constructor(data: T) {
        this.#data = data
        this.#proxy = this.#createProxy(data)
    }

    get data(): T {return this.#data}
    get proxy(): T {return this.#proxy}

    catchupAndSubscribe<P extends PathTuple<T>>(
        observer: Observer<ValueAtPath<T, P>>, ...path: P): Subscription {
        const getValue = (): ValueAtPath<T, P> =>
            path.reduce((object: any, key) => object[key], this.#proxy)
        observer(getValue())
        return this.#notifier.subscribe(key => {
            if (key === path[0]) {observer(getValue())}
        })
    }

    subscribe(observer: Observer<keyof T>): Subscription {
        return this.#notifier.subscribe(observer)
    }

    update(data: T): void {
        const changedKeys = new Set<keyof T>()
        this.#updateRecursive(this.#data, data, changedKeys)
        for (const key of changedKeys) {
            this.#notifier.notify(key)
        }
    }

    terminate(): void {
        this.#notifier.terminate()
    }

    readonly #updateRecursive = (target: any, source: any, changedKeys: Set<keyof T>, rootKey?: keyof T): void => {
        for (const key of Object.keys(source)) {
            const currentRootKey = rootKey ?? key as keyof T
            const newValue = source[key]
            const oldValue = target[key]
            if (newValue !== null && typeof newValue === "object" && !Array.isArray(newValue)) {
                this.#updateRecursive(target[key], newValue, changedKeys, currentRootKey)
            } else if (oldValue !== newValue) {
                target[key] = newValue
                changedKeys.add(currentRootKey)
            }
        }
    }

    readonly #createProxy = <O extends object>(object: O, rootKey?: keyof T): O =>
        new Proxy(object, {
            get: (target, property) => {
                const value = target[property as keyof O]
                if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                    return this.#createProxy(value as object, rootKey ?? property as keyof T) as O[keyof O]
                }
                return value
            },
            set: (target, property, value) => {
                const key = rootKey ?? property as keyof T
                ;(target as any)[property] = value
                this.#notifier.notify(key)
                return true
            },
            preventExtensions: () => false
        })
}
