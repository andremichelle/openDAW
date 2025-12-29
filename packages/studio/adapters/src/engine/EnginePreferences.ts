import {MutableObservableValue, Observer, PathTuple, Subscription, Terminable, ValueAtPath} from "@opendaw/lib-std"
import {EngineSettings} from "./EnginePreferencesSchema"

export interface EnginePreferences {
    settings(): EngineSettings
    subscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription
    catchupAndSubscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription
    createMutableObservableValue<P extends PathTuple<EngineSettings>>(...path: P): MutableObservableValue<ValueAtPath<EngineSettings, P>> & Terminable
}