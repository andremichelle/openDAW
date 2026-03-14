import {Maybe} from "./lang"
import {Observer} from "./observers"
import {Option} from "./option"
import {Subscription} from "./terminable"

/**
 * A function type that rejects async providers.
 * The inner conditional distributes to detect Promise in unions (e.g., Promise<X> | undefined).
 * The outer conditional preserves T as-is in the return type without distribution.
 */
export type SyncProvider<T> = true extends (T extends Promise<unknown> ? true : false) ? never : () => T

export interface Editing {
    modify<R>(modifier: SyncProvider<Maybe<R>>, mark?: boolean): Option<R>
    append<R>(modifier: SyncProvider<Maybe<R>>): Option<R>
    mark(): void
    canUndo(): boolean
    canRedo(): boolean
    undo(): void
    redo(): void
    markSaved(): void
    hasUnsavedChanges(): boolean
    hasNoChanges(): boolean
    revertPending(): void
    subscribe(observer: Observer<void>): Subscription
}

export namespace Editing {
    export const Transient: Editing = Object.freeze({
        modify: <R>(modifier: SyncProvider<Maybe<R>>, _mark?: boolean): Option<R> => Option.wrap(modifier()),
        append: <R>(modifier: SyncProvider<Maybe<R>>): Option<R> => Option.wrap(modifier()),
        mark: () => {},
        canUndo: () => false,
        canRedo: () => false,
        undo: () => {},
        redo: () => {},
        markSaved: () => {},
        hasUnsavedChanges: () => false,
        hasNoChanges: () => true,
        revertPending: () => {},
        subscribe: () => ({terminate: () => {}})
    })
}