import {
    AnyFunc,
    asDefined,
    Func,
    getOrProvide,
    isDefined,
    Maybe,
    Nullable,
    panic,
    Procedure,
    Provider,
    ValueOrProvider
} from "./lang"

export interface Option<T> {
    unwrap(fail?: ValueOrProvider<string>): T
    unwrapOrElse(or: ValueOrProvider<T>): T
    unwrapOrNull(): Nullable<T>
    unwrapOrUndefined(): T | undefined
    match<R>(matchable: Option.Matchable<T, R>): R
    ifSome<R>(procedure: Procedure<T>): R | undefined
    ifAbsent<R>(exec: Func<T, R>): R | undefined
    contains(value: T): boolean
    isEmpty(): boolean
    nonEmpty(): boolean
    map<U>(func: Func<T, Maybe<U>>): Option<U>
    mapOr<U>(func: Func<T, U>, or: ValueOrProvider<U>): U
    flatMap<U>(func: Func<T, Option<U>>): Option<U>
    equals(other: Option<T>): boolean
    assert(fail?: ValueOrProvider<string>): this
}

export namespace Option {
    export interface Matchable<T, RETURN> {
        some: Func<T, RETURN>
        none: Provider<RETURN>
    }

    export const wrap = <T>(value: Maybe<T>): Option<T | never> => isDefined(value) ? new Some(value) : None
    export const from = <T>(provider: Provider<Maybe<T>>): Option<T> => wrap(provider())
    export const tryCatch = <T>(provider: Provider<T>): Option<T> => {
        try {return Option.wrap(provider())} catch (_error) {return Option.None}
    }
    export const execute = <F extends AnyFunc>(func: Maybe<F>, ...args: Parameters<F>)
        : Option<ReturnType<F>> => Option.wrap(func?.apply(null, args))
    export const async = <RESULT>(promise: Promise<RESULT>): Promise<Option<RESULT>> =>
        promise.then(value => wrap(value), () => None)

    export class Some<T> implements Option<T> {
        readonly #value: T
        constructor(value: T) {this.#value = asDefined(value)}
        unwrap(): T { return this.#value }
        unwrapOrElse(_: ValueOrProvider<T>): T { return this.#value }
        unwrapOrNull(): Nullable<T> { return this.#value }
        unwrapOrUndefined(): T | undefined {return this.#value }
        contains(value: T): boolean { return value === this.#value }
        match<R>(matchable: Matchable<T, R>): R {return matchable.some(this.#value)}
        ifSome<R extends undefined>(run: Func<T, R>): R {return run(this.#value)}
        ifAbsent<R>(_func: Func<T, R>): R | undefined {return undefined}
        isEmpty(): boolean { return false }
        nonEmpty(): boolean { return true }
        map<U>(callback: (value: T) => Maybe<U>): Option<U> {return Option.wrap(callback(this.#value))}
        mapOr<U>(func: Func<T, U>, _or: U | Provider<U>): U {return func(this.#value)}
        flatMap<U>(callback: (value: T) => Option<U>): Option<U> {return callback(this.#value)}
        equals(other: Option<T>): boolean {return this.unwrapOrNull() === other.unwrapOrNull()}
        assert(_fail?: ValueOrProvider<string>): this {return this}
        toString(): string {return `{Option.Some(${this.#value})}`}
        get [Symbol.toStringTag]() {return this.toString()}
    }

    export const None: Option<never> = new class implements Option<never> {
        readonly unwrap = (fail?: ValueOrProvider<string>): never => panic(isDefined(fail) ? getOrProvide(fail) : "unwrap failed")
        readonly unwrapOrElse = <T>(value: ValueOrProvider<T>): T => getOrProvide(value)
        readonly unwrapOrNull = (): Nullable<never> => null
        readonly unwrapOrUndefined = <T>(): T | undefined => undefined
        readonly contains = (_: unknown): boolean => false
        readonly match = <R>(matchable: Matchable<never, R>): R => matchable.none()
        readonly ifSome = (_: Procedure<never>): undefined => {}
        readonly ifAbsent = <R>(exec: Func<never, R>): R | undefined => exec(undefined as never)
        readonly isEmpty = (): boolean => true
        readonly nonEmpty = (): boolean => false
        readonly map = <U>(_: (_: never) => Maybe<U>): Option<U> => None
        readonly mapOr = <U>(_: Func<never, U>, or: ValueOrProvider<U>): U => getOrProvide(or)
        readonly flatMap = (_: (_: never) => Option<never>): Option<never> => None
        readonly equals = (other: Option<any>): boolean => other.isEmpty()
        readonly assert = (fail?: ValueOrProvider<string>): this => panic(getOrProvide(fail) ?? "assert failed")
        readonly toString = (): string => "{Option.None}"
        get [Symbol.toStringTag]() {return this.toString()}
    }
}