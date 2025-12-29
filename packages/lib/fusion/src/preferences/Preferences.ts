import {MutableObservableValue, Observer, PathTuple, Subscription, Terminable, ValueAtPath} from "@opendaw/lib-std"

export interface Preferences<SETTINGS> {
    get settings(): SETTINGS
    subscribe<P extends PathTuple<SETTINGS>>(
        observer: Observer<ValueAtPath<SETTINGS, P>>, ...path: P): Subscription
    catchupAndSubscribe<P extends PathTuple<SETTINGS>>(
        observer: Observer<ValueAtPath<SETTINGS, P>>, ...path: P): Subscription
    createMutableObservableValue<P extends PathTuple<SETTINGS>>(...path: P)
        : MutableObservableValue<ValueAtPath<SETTINGS, P>> & Terminable
}
