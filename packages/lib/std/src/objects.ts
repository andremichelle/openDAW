import {panic} from "./lang"

export namespace Objects {
    const Empty = Object.freeze({})

    export const empty = <K extends keyof any, V>(): Readonly<Record<K, V>> => Empty as Readonly<Record<K, V>>

    export type Disjoint<U, V> = keyof U & keyof V extends never ? V : never

    export const mergeNoOverlap = <U extends {}, V extends {}>(u: U, v: Disjoint<U, V>): U & V => {
        const keys = new Set(Object.keys(u))
        for (const key of Object.keys(v)) {
            if (keys.has(key)) {
                return panic(`'${key}' is an overlapping key`)
            }
        }
        return ({...u, ...v}) as U & V
    }

    export const include = <T, K extends readonly (keyof T)[]>(obj: T, ...keys: K): Pick<T, K[number]> => {
        const out = {} as Pick<T, K[number]>
        for (const k of keys) out[k] = obj[k]
        return out
    }

    export const exclude = <T extends {}, K extends keyof T>(obj: T, ...keys: Array<K>): Omit<T, K> => {
        const exclude = new Set<keyof T>(keys)
        return Object.entries(obj).reduce((result: any, [key, value]) => {
            if (!exclude.has(key as keyof T)) {
                result[key] = value
            }
            return result
        }, {}) as Omit<T, K>
    }

    export const overwrite = <T extends {}>(target: T, patch: Partial<T>): T => Object.assign(target, patch)

    export const entries = <T extends object>(obj: T): ReadonlyArray<[keyof T, T[keyof T]]> =>
        Object.entries(obj) as unknown as ReadonlyArray<[keyof T, T[keyof T]]>
}