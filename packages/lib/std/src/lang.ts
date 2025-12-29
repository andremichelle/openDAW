// noinspection JSUnusedGlobalSymbols

// Warning, those number types do not truncate decimal places or handle overflows. They are just hints.
export type byte = number
export type short = number
export type int = number
export type float = number
export type double = number
export type long = bigint
export type unitValue = number // 0...1
export type bipolar = number // -1...1
export type NumberArray =
    ReadonlyArray<number>
    | Float32Array
    | Float64Array
    | Uint8Array
    | Int8Array
    | Uint16Array
    | Int16Array
    | Uint32Array
    | Int32Array
export type FloatArray = Float32Array | Float64Array | Array<number>
export type Primitive = boolean | byte | short | int | long | float | double | string | Readonly<Int8Array>
export type JsType =
    "string"
    | "number"
    | "boolean"
    | "object"
    | "undefined"
    | "function"
    | "symbol"
    | "bigint"
    | "null"
export type StructuredCloneable =
    | string
    | number
    | boolean
    | null
    | undefined
    | StructuredCloneable[]
    | { [key: string]: StructuredCloneable }
    | ArrayBuffer
    | DataView
    | Date
    | Map<StructuredCloneable, StructuredCloneable>
    | Set<StructuredCloneable>
    | RegExp
export type JSONValue = string | number | boolean | null | JSONArray | JSONObject
export type JSONArray = Array<JSONValue>
export type JSONObject = { [key: string]: Optional<JSONValue> }
export type Id<T extends unknown> = T & { id: int }
export type Sign = -1 | 0 | 1
export type Optional<T> = T | undefined
export type Nullable<T> = T | null
export type Maybe<T> = T | undefined | null
export type Class<T = object> = Function & { prototype: T }
export type Exec = () => void
export type Provider<T> = () => T
export type ValueOrProvider<T> = T | Provider<T>
export type Procedure<T> = (value: T) => void
export type Predicate<T> = (value: T) => boolean
export type Func<U, T> = (value: U) => T
export type Comparator<T> = (a: T, b: T) => number
export type Comparable<T> = { compareTo: (other: T) => number }
export type Equality<T> = { equals: (other: T) => boolean }
export type AnyFunc = (...args: any[]) => any
export type Stringifiable = { toString(): string }
export type MakeMutable<T> = { -readonly [P in keyof T]: T[P] }
export type PathTuple<T> = T extends object
    ? { [K in keyof T]: [K] | [K, ...PathTuple<T[K]>] }[keyof T]
    : []
export type ValueAtPath<T, P extends readonly unknown[]> = P extends readonly [infer K, ...infer Rest]
    ? K extends keyof T
        ? Rest extends [] ? T[K] : ValueAtPath<T[K], Rest>
        : never
    : T
export type AssertType<T> = (value: unknown) => value is T
export const identity = <T>(value: T): T => value
export const isDefined = <T>(value: Maybe<T>): value is T => value !== undefined && value !== null
export const isNull = (value: unknown): value is null => value === null
export const isNotNull = <T>(value: Nullable<T>): value is T => value !== null
export const isUndefined = (value: unknown): value is undefined => value === undefined
export const isNotUndefined = <T>(value: Optional<T>): value is T => value !== undefined
export const isAbsent = (value: unknown): value is undefined | null => value === undefined || value === null
export const ifDefined = <T, R = void>(value: Maybe<T>, procedure: Func<T, R>): R | undefined =>
    value !== undefined && value !== null ? procedure(value) : undefined
export const asDefined = <T>(value: Maybe<T>, fail: ValueOrProvider<string> = "asDefined failed"): T =>
    value === null || value === undefined ? panic(getOrProvide(fail)) : value
export const isInstanceOf = <T>(obj: unknown, clazz: Class<T>): obj is T => obj instanceof clazz
export const asInstanceOf = <T>(obj: unknown, clazz: Class<T>): T =>
    obj instanceof clazz ? obj as T : panic(`${obj} is not instance of ${clazz}`)
export const assertInstanceOf: <T>(obj: unknown, clazz: Class<T>) =>
    asserts obj is T = <T>(obj: unknown, clazz: Class<T>): asserts obj is T => {
    if (!(obj instanceof clazz)) {panic(`${obj} is not instance of ${clazz}`)}
}
export const isSameClass = (a: object, b: object): boolean => a.constructor === b.constructor
export const tryProvide = <T>(provider: Provider<T>): T => {
    try {return provider()} catch (reason) {return panic(String(reason))}
}
export const getOrProvide = <T>(value: ValueOrProvider<T>): T => value instanceof Function ? value() : value
export const safeWrite = (object: any, property: string, value: any): void =>
    property in object ? object[property] = value : undefined
export const safeExecute = <F extends AnyFunc>(func: Maybe<F>, ...args: Parameters<F>): Maybe<ReturnType<F>> =>
    func?.apply(null, args)
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    isDefined(value) && typeof value === "object"
export const hasField = (record: Record<string, unknown>, key: string, type: JsType): boolean => {
    if (!(key in record)) return false
    const value = record[key]
    return type === "null" ? value === null : typeof value === type
}
export const safeRead = (object: unknown, ...keys: string[]): Maybe<unknown> => {
    let current: unknown = object
    for (const key of keys) {
        if (!isRecord(current) || !(key in current)) {return undefined}
        current = current[key]
    }
    return current
}
export const Unhandled = <R>(empty: never): R => {throw new Error(`Unhandled ${empty}`)}
export const panic = (issue?: string | Error | unknown): never => {
    throw typeof issue === "string" ? new Error(issue) : issue
}
export const assert = (condition: boolean, fail: ValueOrProvider<string>): void =>
    condition ? undefined : panic(getOrProvide(fail))
export const checkIndex = (index: int, array: { length: int }): int =>
    index >= 0 && index < array.length ? index : panic(`Index ${index} is out of bounds`)
export const InaccessibleProperty = <T>(failMessage: string): T =>
    new Proxy({}, {get() { return panic(failMessage) }}) as T
export const canWrite = <T>(obj: T, key: keyof any): obj is T & Record<typeof key, unknown> => {
    while (isDefined(obj)) {
        const descriptor = Object.getOwnPropertyDescriptor(obj, key)
        if (isDefined(descriptor)) {return typeof descriptor.set === "function"}
        obj = Object.getPrototypeOf(obj)
    }
    return false
}
export const requireProperty = <T extends {}>(object: T, key: keyof T): void => {
    const {status, value} = tryCatch(() => object instanceof Function ? object.name : object.constructor.name)
    const feature = status === "failure" ? `${object}.${String(key)}` : `${value}.${String(key)}`
    console.debug(`%c${feature}%c available`, "color: hsl(200, 83%, 60%)", "color: inherit")
    if (!(key in object)) {throw feature}
}

export class SuccessResult<T> {
    readonly status = "success"
    constructor(readonly value: T) {}
    error = InaccessibleProperty("Cannot access error when succeeded")
}

export class FailureResult {
    readonly status = "failure"
    constructor(readonly error: unknown) {}
    value = InaccessibleProperty("Cannot access value when failed")
}

export const tryCatch = <T>(statement: Provider<T>): SuccessResult<T> | FailureResult => {
    try {
        return new SuccessResult(statement())
    } catch (error) {
        return new FailureResult(error)
    }
}
export const isValidIdentifier = (identifier: string): boolean => /^[A-Za-z_$][A-Za-z0-9_]*$/.test(identifier)
export const asValidIdentifier = (identifier: string): string =>
    isValidIdentifier(identifier) ? identifier : panic(`'${identifier}' is not a valid identifier`)
export const asEnumValue = <
    E extends Record<string, string | number>
>(value: string | number, enm: E): E[keyof E] => {
    const keys = Object.keys(enm)
    if (keys.length === 0) return panic("Empty enum object (are you using `const enum`?)")
    const values = Object.keys(enm)
        .filter(k => isNaN(Number(k)))
        .map(k => enm[k as keyof typeof enm])
    return values.includes(value as any) ? value as E[keyof E] : panic(`Invalid enum value: ${String(value)}`)
}
export const EmptyExec: Exec = (): void => {}
export const EmptyProvider: Provider<any> = (): any => {}
export const EmptyProcedure: Procedure<any> = (_: any): void => {}