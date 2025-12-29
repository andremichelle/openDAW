import {Subscription, Terminable} from "./terminable"
import {Notifier} from "./notifier"
import {PathTuple, ValueAtPath} from "./lang"
import {Observer} from "./observers"

export class VirtualObject<T extends object> implements Terminable {
    readonly #notifier = new Notifier<ReadonlyArray<PropertyKey>>()
    readonly #data: T
    readonly #proxy: T

    constructor(data: T) {
        this.#data = data
        this.#proxy = this.#createProxy(data, [])
    }

    get data(): T {return this.#data}
    get proxy(): T {return this.#proxy}

    subscribe<P extends PathTuple<T>>(observer: Observer<ValueAtPath<T, P>>, ...path: P): Subscription {
        const getValue = (): ValueAtPath<T, P> =>
            path.reduce((object: any, key) => object[key], this.#proxy)
        return this.#notifier.subscribe(notifiedPath => {
            if (this.#pathsOverlap(notifiedPath, path as ReadonlyArray<PropertyKey>)) {observer(getValue())}
        })
    }

    catchupAndSubscribe<P extends PathTuple<T>>(observer: Observer<ValueAtPath<T, P>>, ...path: P): Subscription {
        const getValue = (): ValueAtPath<T, P> =>
            path.reduce((object: any, key) => object[key], this.#proxy)
        observer(getValue())
        return this.subscribe(observer, ...path)
    }

    subscribeAll(observer: Observer<keyof T>): Subscription {
        return this.#notifier.subscribe(path => observer(path[0] as keyof T))
    }

    update(data: T): void {
        const changedRootKeys = new Set<keyof T>()
        this.#updateRecursive(this.#data, data, changedRootKeys)
        for (const key of changedRootKeys) {
            this.#notifier.notify([key])
        }
    }

    terminate(): void {
        this.#notifier.terminate()
    }

    readonly #pathsOverlap = (a: ReadonlyArray<PropertyKey>, b: ReadonlyArray<PropertyKey>): boolean => {
        const minLen = Math.min(a.length, b.length)
        for (let i = 0; i < minLen; i++) {
            if (a[i] !== b[i]) {return false}
        }
        return true
    }

    readonly #updateRecursive = (target: any, source: any, changedRootKeys: Set<keyof T>, rootKey?: keyof T): void => {
        for (const key of Object.keys(source)) {
            const currentRootKey = rootKey ?? key as keyof T
            const newValue = source[key]
            const oldValue = target[key]
            if (newValue !== null && typeof newValue === "object" && !Array.isArray(newValue)) {
                this.#updateRecursive(target[key], newValue, changedRootKeys, currentRootKey)
            } else if (oldValue !== newValue) {
                target[key] = newValue
                changedRootKeys.add(currentRootKey)
            }
        }
    }

    readonly #createProxy = <O extends object>(object: O, path: PropertyKey[]): O =>
        new Proxy(object, {
            get: (target, property) => {
                const value = target[property as keyof O]
                if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                    return this.#createProxy(value as object, [...path, property]) as O[keyof O]
                }
                return value
            },
            set: (target, property, value) => {
                ;(target as any)[property] = value
                this.#notifier.notify([...path, property])
                return true
            },
            preventExtensions: () => false
        })
}
