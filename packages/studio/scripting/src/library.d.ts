// noinspection JSUnusedGlobalSymbols

interface ArrayBuffer {
    readonly byteLength: number
    slice(begin: number, end?: number): ArrayBuffer
}

interface SharedArrayBuffer {
    readonly byteLength: number
    slice(begin: number, end?: number): SharedArrayBuffer
}

type ArrayBufferLike = ArrayBuffer | SharedArrayBuffer

declare class TypedArray {
    readonly buffer: ArrayBufferLike
    readonly byteOffset: number
    readonly byteLength: number
    readonly length: number
    [index: number]: number | bigint
    copyWithin(target: number, start: number, end?: number): this
    every(callbackfn: (value: any, index: number, array: this) => boolean): boolean
    fill(value: any, start?: number, end?: number): this
    filter(callbackfn: (value: any, index: number, array: this) => boolean): this
    find(callbackfn: (value: any, index: number, array: this) => boolean): any
    findIndex(callbackfn: (value: any, index: number, array: this) => boolean): number
    forEach(callbackfn: (value: any, index: number, array: this) => void): void
    includes(value: any, fromIndex?: number): boolean
    indexOf(value: any, fromIndex?: number): number
    join(separator?: string): string
    lastIndexOf(value: any, fromIndex?: number): number
    map(callbackfn: (value: any, index: number, array: this) => any): this
    reduce(callbackfn: (prev: any, curr: any, index: number, array: this) => any): any
    reduceRight(callbackfn: (prev: any, curr: any, index: number, array: this) => any): any
    reverse(): this
    set(array: ArrayLike<any>, offset?: number): void
    slice(start?: number, end?: number): this
    some(callbackfn: (value: any, index: number, array: this) => boolean): boolean
    sort(compareFn?: (a: any, b: any) => number): this
    subarray(begin?: number, end?: number): this
    toLocaleString(): string
    toString(): string
    values(): IterableIterator<any>
    keys(): IterableIterator<number>
    entries(): IterableIterator<[number, any]>
    [Symbol.iterator](): IterableIterator<any>
}

declare class Int8Array extends TypedArray {
    [index: number]: number
    constructor(length: number)
    constructor(array: ArrayLike<number> | ArrayBuffer)
}

declare class Uint8Array extends TypedArray {
    [index: number]: number;
    constructor(length: number);
    constructor(array: ArrayLike<number> | ArrayBuffer)
}

declare class Uint8ClampedArray extends TypedArray {
    [index: number]: number;
    constructor(length: number);
    constructor(array: ArrayLike<number> | ArrayBuffer)
}

declare class Int16Array extends TypedArray {
    [index: number]: number;
    constructor(length: number);
    constructor(array: ArrayLike<number> | ArrayBuffer)
}

declare class Uint16Array extends TypedArray {
    [index: number]: number;
    constructor(length: number);
    constructor(array: ArrayLike<number> | ArrayBuffer)
}

declare class Int32Array extends TypedArray {
    [index: number]: number;
    constructor(length: number);
    constructor(array: ArrayLike<number> | ArrayBuffer)
}

declare class Uint32Array extends TypedArray {
    [index: number]: number;
    constructor(length: number);
    constructor(array: ArrayLike<number> | ArrayBuffer)
}

declare class Float32Array<TBuffer extends ArrayBufferLike = ArrayBuffer> extends TypedArray {
    [index: number]: number;
    readonly buffer: TBuffer
    constructor(length: number);
    constructor(array: ArrayLike<number> | ArrayBuffer)
}

declare class Float64Array extends TypedArray {
    [index: number]: number;
    constructor(length: number);
    constructor(array: ArrayLike<number> | ArrayBuffer)
}

declare class BigInt64Array extends TypedArray {
    [index: number]: bigint;
    constructor(length: number);
    constructor(array: ArrayLike<bigint> | ArrayBuffer)
}

declare class BigUint64Array extends TypedArray {
    [index: number]: bigint;
    constructor(length: number);
    constructor(array: ArrayLike<bigint> | ArrayBuffer)
}

declare class Array<T> {
    readonly length: number
    [index: number]: T

    constructor()
    constructor(length: number)
    constructor(...items: T[])

    at(index: number): T | undefined
    concat(...items: (T | ConcatArray<T>)[]): T[]
    copyWithin(target: number, start: number, end?: number): this
    entries(): IterableIterator<[number, T]>
    every(callbackfn: (value: T, index: number, array: T[]) => boolean): boolean
    fill(value: T, start?: number, end?: number): this
    filter(callbackfn: (value: T, index: number, array: T[]) => boolean): T[]
    find(callbackfn: (value: T, index: number, array: T[]) => boolean): T | undefined
    findIndex(callbackfn: (value: T, index: number, array: T[]) => boolean): number
    flat<U>(this: U[][], depth?: number): U[]
    flatMap<U>(callbackfn: (value: T, index: number, array: T[]) => U | readonly U[]): U[]
    forEach(callbackfn: (value: T, index: number, array: T[]) => void): void
    includes(value: T, fromIndex?: number): boolean
    indexOf(value: T, fromIndex?: number): number
    join(separator?: string): string
    keys(): IterableIterator<number>
    lastIndexOf(value: T, fromIndex?: number): number
    map<U>(callbackfn: (value: T, index: number, array: T[]) => U): U[]
    pop(): T | undefined
    push(...items: T[]): number
    reduce(callbackfn: (prev: T, curr: T, index: number, array: T[]) => T): T
    reduce<U>(callbackfn: (prev: U, curr: T, index: number, array: T[]) => U, initialValue: U): U
    reduceRight(callbackfn: (prev: T, curr: T, index: number, array: T[]) => T): T
    reverse(): this
    shift(): T | undefined
    slice(start?: number, end?: number): T[]
    some(callbackfn: (value: T, index: number, array: T[]) => boolean): boolean
    sort(compareFn?: (a: T, b: T) => number): this
    splice(start: number, deleteCount?: number, ...items: T[]): T[]
    toLocaleString(): string
    toString(): string
    unshift(...items: T[]): number
    values(): IterableIterator<T>
    [Symbol.iterator](): IterableIterator<T>
    [Symbol.unscopables](): Record<string, boolean>
}

interface ConcatArray<T> {
    readonly length: number
    [n: number]: T
    concat(...items: ConcatArray<T>[]): T[]
}

interface PromiseLike<T> {
    then<R1 = T, R2 = never>(onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
                             onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2>
}

interface Promise<T> {
    then<R1 = T, R2 = never>(onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
                             onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2>
    catch<R = never>(onrejected?: ((reason: any) => R | PromiseLike<R>) | null): Promise<T | R>
    finally(onfinally?: (() => void) | null): Promise<T>
}

interface PromiseConstructor {
    readonly prototype: Promise<unknown>;
    new<T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void): Promise<T>;
    all<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]>; }>;
    race<T extends readonly unknown[] | []>(values: T): Promise<Awaited<T[number]>>;
    reject<T = never>(reason?: any): Promise<T>;
    resolve(): Promise<void>;
    resolve<T>(value: T): Promise<Awaited<T>>;
    resolve<T>(value: T | PromiseLike<T>): Promise<Awaited<T>>;
}

declare var Promise: PromiseConstructor

declare function setInterval(handler: TimerHandler, timeout?: number, ...arguments: any[]): number;
declare function setTimeout(handler: TimerHandler, timeout?: number, ...arguments: any[]): number;

interface IteratorYieldResult<TYield> {
    done?: false
    value: TYield
}

interface IteratorReturnResult<TReturn> {
    done: true
    value: TReturn
}

type IteratorResult<T, TReturn = any> = IteratorYieldResult<T> | IteratorReturnResult<TReturn>

interface Iterator<T, TReturn = any, TNext = undefined> {
    next(...args: [] | [TNext]): IteratorResult<T, TReturn>
    return?(value?: TReturn): IteratorResult<T, TReturn>
    throw?(e?: any): IteratorResult<T, TReturn>
}

interface Iterable<T, TReturn = any, TNext = any> {
    [Symbol.iterator](): Iterator<T, TReturn, TNext>
}

interface IterableIterator<T, TReturn = any, TNext = any> extends Iterator<T, TReturn, TNext> {
    [Symbol.iterator](): IterableIterator<T, TReturn, TNext>
}

interface SymbolConstructor {
    readonly iterator: symbol
    readonly unscopables: symbol
}

declare var Symbol: SymbolConstructor

type Partial<T> = { [P in keyof T]?: T[P] }
type Required<T> = { [P in keyof T]-?: T[P] }
type Readonly<T> = { readonly [P in keyof T]: T[P] }
type Pick<T, K extends keyof T> = { [P in K]: T[P] }
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>
type Record<K extends keyof any, T> = { [P in K]: T }
type Exclude<T, U> = T extends U ? never : T
type Extract<T, U> = T extends U ? T : never
type NonNullable<T> = T extends null | undefined ? never : T
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any
type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never
type Awaited<T> = T extends null | undefined ? T : T extends object & {
    then(onfulfilled: infer F, ...args: infer _): any
} ? F extends ((value: infer V, ...args: infer _) => any) ? Awaited<V> : never : T

interface ReadonlyArray<T> {
    readonly length: number
    readonly [n: number]: T
    concat(...items: (T | ConcatArray<T>)[]): T[]
    every(callbackfn: (value: T, index: number, array: readonly T[]) => boolean): boolean
    filter(callbackfn: (value: T, index: number, array: readonly T[]) => boolean): T[]
    find(callbackfn: (value: T, index: number, array: readonly T[]) => boolean): T | undefined
    findIndex(callbackfn: (value: T, index: number, array: readonly T[]) => boolean): number
    forEach(callbackfn: (value: T, index: number, array: readonly T[]) => void): void
    includes(value: T, fromIndex?: number): boolean
    indexOf(value: T, fromIndex?: number): number
    join(separator?: string): string
    lastIndexOf(value: T, fromIndex?: number): number
    at(index: number): T | undefined
    flatMap<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U | readonly U[]): U[]
    map<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U): U[]
    reduce(callbackfn: (prev: T, curr: T, index: number, array: readonly T[]) => T): T
    reduce<U>(callbackfn: (prev: U, curr: T, index: number, array: readonly T[]) => U, initialValue: U): U
    reduceRight(callbackfn: (prev: T, curr: T, index: number, array: readonly T[]) => T): T
    slice(start?: number, end?: number): T[]
    some(callbackfn: (value: T, index: number, array: readonly T[]) => boolean): boolean
    [Symbol.iterator](): IterableIterator<T>
}
interface Math {
    readonly PI: number
    readonly E: number
    abs(x: number): number
    acos(x: number): number
    asin(x: number): number
    atan(x: number): number
    atan2(y: number, x: number): number
    ceil(x: number): number
    cos(x: number): number
    exp(x: number): number
    floor(x: number): number
    log(x: number): number
    log2(x: number): number
    log10(x: number): number
    max(...values: number[]): number
    min(...values: number[]): number
    pow(x: number, y: number): number
    random(): number
    round(x: number): number
    sign(x: number): number
    sin(x: number): number
    sqrt(x: number): number
    tan(x: number): number
    tanh(x: number): number
    trunc(x: number): number
    hypot(...values: number[]): number
    cbrt(x: number): number
    imul(a: number, b: number): number
    fround(x: number): number
}

declare const Math: Math

interface NumberConstructor {
    readonly MAX_SAFE_INTEGER: number
    readonly MIN_SAFE_INTEGER: number
    readonly MAX_VALUE: number
    readonly MIN_VALUE: number
    readonly EPSILON: number
    readonly POSITIVE_INFINITY: number
    readonly NEGATIVE_INFINITY: number
    readonly NaN: number
    isFinite(value: unknown): boolean
    isInteger(value: unknown): boolean
    isNaN(value: unknown): boolean
    isSafeInteger(value: unknown): boolean
    parseFloat(text: string): number
    parseInt(text: string, radix?: number): number
    (value?: unknown): number
}

declare const Number: NumberConstructor

interface StringConstructor {
    (value?: unknown): string
    fromCharCode(...codes: number[]): string
}

declare const String: StringConstructor

interface BooleanConstructor {
    (value?: unknown): boolean
}

declare const Boolean: BooleanConstructor

interface ObjectConstructor {
    keys(object: object): string[]
    values<T>(object: { [key: string]: T } | ArrayLike<T>): T[]
    entries<T>(object: { [key: string]: T } | ArrayLike<T>): [string, T][]
    assign<T extends object, U>(target: T, source: U): T & U
    freeze<T>(object: T): Readonly<T>
}

declare const Object: ObjectConstructor

interface JSON {
    parse(text: string): any
    stringify(value: unknown, replacer?: null, space?: string | number): string
}

declare const JSON: JSON

interface Console {
    log(...data: unknown[]): void
    info(...data: unknown[]): void
    warn(...data: unknown[]): void
    error(...data: unknown[]): void
    debug(...data: unknown[]): void
    table(data: unknown): void
}

declare const console: Console

declare class Error {
    readonly name: string
    readonly message: string
    readonly stack?: string
    constructor(message?: string)
}

declare class RangeError extends Error {}

declare class TypeError extends Error {}

declare class Date {
    constructor()
    constructor(value: number | string)
    static now(): number
    getTime(): number
    toISOString(): string
    toString(): string
}

declare const Infinity: number
declare const NaN: number
declare function isNaN(value: number): boolean
declare function isFinite(value: number): boolean
declare function parseFloat(text: string): number
declare function parseInt(text: string, radix?: number): number

interface Object {}
interface Function {}
interface CallableFunction extends Function {}
interface NewableFunction extends Function {}
interface IArguments {}
interface RegExp {}
interface Boolean {}
interface Number {
    toFixed(fractionDigits?: number): string
    toString(radix?: number): string
}
interface String {
    readonly length: number
    charAt(index: number): string
    charCodeAt(index: number): number
    indexOf(search: string, position?: number): number
    includes(search: string, position?: number): boolean
    startsWith(search: string, position?: number): boolean
    endsWith(search: string, position?: number): boolean
    slice(start?: number, end?: number): string
    split(separator: string, limit?: number): string[]
    toLowerCase(): string
    toUpperCase(): string
    trim(): string
    padStart(maxLength: number, fillString?: string): string
    padEnd(maxLength: number, fillString?: string): string
    repeat(count: number): string
    replace(search: string, replacement: string): string
    [index: number]: string
}
interface ArrayLike<T> {
    readonly length: number
    readonly [n: number]: T
}
interface TemplateStringsArray extends ReadonlyArray<string> {}
type TimerHandler = string | Function

interface Map<K, V> {
    readonly size: number
    clear(): void
    delete(key: K): boolean
    forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void): void
    get(key: K): V | undefined
    has(key: K): boolean
    set(key: K, value: V): this
    keys(): IterableIterator<K>
    values(): IterableIterator<V>
    entries(): IterableIterator<[K, V]>
    [Symbol.iterator](): IterableIterator<[K, V]>
}

interface MapConstructor {
    new <K, V>(entries?: Iterable<readonly [K, V]> | null): Map<K, V>
}

declare const Map: MapConstructor

interface Set<T> {
    readonly size: number
    add(value: T): this
    clear(): void
    delete(value: T): boolean
    forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void): void
    has(value: T): boolean
    values(): IterableIterator<T>
    [Symbol.iterator](): IterableIterator<T>
}

interface SetConstructor {
    new <T>(values?: Iterable<T> | null): Set<T>
}

declare const Set: SetConstructor
