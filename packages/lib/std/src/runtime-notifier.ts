import {assert, EmptyExec, Exec, unitValue} from "./lang"
import {Option} from "./option"
import {ObservableValue} from "./observables"
import {Terminable} from "./terminable"

export namespace RuntimeNotification {
    export type InfoRequest = {
        headline?: string
        message: string
        okText?: string
        origin?: Element
        abortSignal?: AbortSignal
    }

    export type ApproveRequest = {
        headline?: string
        message: string
        approveText?: string
        cancelText?: string
        origin?: Element
        abortSignal?: AbortSignal
    }

    export type ProgressRequest = {
        headline: string
        message?: string
        progress?: ObservableValue<unitValue>
        cancel?: Exec
        origin?: Element
    }

    export interface ProgressUpdater extends Terminable {
        set message(value: string)
    }

    export type NotifyRequest = {
        message: string
        icon?: string
        origin?: Element
    }

    export interface Installer {
        install(notifier: Notifier): void
    }

    export interface Notifier {
        info(request: InfoRequest): Promise<void>
        approve(request: ApproveRequest): Promise<boolean>
        progress(request: ProgressRequest): ProgressUpdater
        notify(request: NotifyRequest): void
    }
}

export const RuntimeNotifier: RuntimeNotification.Notifier & RuntimeNotification.Installer = (() => {
    let notifierOption: Option<RuntimeNotification.Notifier> = Option.None
    return ({
        info: (request: RuntimeNotification.InfoRequest): Promise<void> => notifierOption.match({
            none: () => Promise.resolve(),
            some: notifier => notifier.info(request)
        }),
        approve: (request: RuntimeNotification.ApproveRequest): Promise<boolean> => notifierOption.match({
            none: () => Promise.resolve(true),
            some: notifier => notifier.approve(request)
        }),
        progress: (request: RuntimeNotification.ProgressRequest): RuntimeNotification.ProgressUpdater => notifierOption.match({
            none: () => ({message: "", terminate: EmptyExec}),
            some: notifier => notifier.progress(request)
        }),
        notify: (request: RuntimeNotification.NotifyRequest): void => notifierOption.match({
            none: EmptyExec,
            some: notifier => notifier.notify(request)
        }),
        install: (notifier: RuntimeNotification.Notifier) => {
            assert(notifierOption.isEmpty(), "RuntimeNotification already installed")
            notifierOption = Option.wrap(notifier)
        }
    })
})()