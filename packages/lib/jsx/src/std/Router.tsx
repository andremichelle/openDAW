import {createElement, replaceChildren} from "../create-element"
import {Exec, isDefined, Option, Provider, safeExecute, Terminable, TerminableOwner, Terminator} from "@opendaw/lib-std"
import {JsxValue} from "../types"
import {RouteLocation, RouteMatcher} from "../routes"

export type PageContext<SERVICE = never> = {
    service: SERVICE
    lifecycle: TerminableOwner
    path: string
    error: string
}

export type PageFactory<SERVICE = never> = (context: PageContext<SERVICE>) => JsxValue | Promise<JsxValue>

export type RouterConstruct<SERVICE = never> = {
    runtime: TerminableOwner
    service: SERVICE
    routes: Array<{ path: string, factory: PageFactory<SERVICE>, reuse?: boolean }>
    fallback: PageFactory<SERVICE>
    error?: PageFactory<SERVICE>
    preloader?: Provider<Terminable>
    onshow?: Exec
}

type PageRequest<SERVICE> = {
    lifecycle: Terminable
    preloader: Option<Terminable>
    content: Promise<JsxValue>
    path: string
    factory: PageFactory<SERVICE>
    state: "loading" | "cancelled"
}

export const Router = <SERVICE = never>({
                                            runtime,
                                            service,
                                            routes,
                                            fallback,
                                            preloader,
                                            error,
                                            onshow
                                        }: RouterConstruct<SERVICE>) => {
    const routing = RouteMatcher.create(routes)

    const container: HTMLDivElement = <div style={{display: "contents"}}/>

    let loading: Option<PageRequest<SERVICE>> = Option.None
    let showing: Option<PageRequest<SERVICE>> = Option.None

    const fetchPage = async (pageFactory: PageFactory<SERVICE>, path: string): Promise<void> => {
        if (loading.nonEmpty()) {
            const request: PageRequest<SERVICE> = loading.unwrap()
            request.preloader.ifSome(lifecycle => lifecycle.terminate())
            request.state = "cancelled"
            loading = Option.None
        }
        const lifecycle = new Terminator()
        const pageResult: JsxValue | Promise<JsxValue> = pageFactory({
            service,
            lifecycle,
            path,
            error: ""
        })
        const content: Promise<JsxValue> = pageResult instanceof Promise ? pageResult : Promise.resolve(pageResult)
        const request: PageRequest<SERVICE> = {
            path,
            content,
            lifecycle,
            factory: pageFactory,
            preloader: Option.wrap(safeExecute(preloader)),
            state: "loading"
        }
        loading = Option.wrap(request)
        let element: JsxValue
        try {
            element = await content
        } catch (reason) {
            console.warn(reason)
            if (isDefined(error)) {
                return fetchPage(error, path)
            } else {
                alert(`Could not load page (${reason})`)
            }
        }
        if (request.state === "cancelled") {
            request.lifecycle.terminate()
        } else if (request.path === path) {
            if (showing.nonEmpty()) {
                showing.unwrap().lifecycle.terminate()
                showing = Option.None
            }
            if (loading.nonEmpty()) {
                loading.unwrap().preloader.ifSome(lifecycle => lifecycle.terminate())
                loading = Option.None
            }
            replaceChildren(container, element)
            showing = Option.wrap(request)
            safeExecute(onshow)
        }
    }
    runtime.own(RouteLocation.get()
        .catchupAndSubscribe((location: RouteLocation) => {
            if (showing.unwrapOrNull()?.path === location.path) {
                return
            }
            const route = routing.resolve(location.path)
            const factory = route.mapOr(({factory}) => factory, () => fallback)
            const current = showing.unwrapOrNull()
            if (isDefined(current) && current.factory === factory && route.mapOr(({reuse}) => reuse === true, false)) {
                current.path = location.path
                return
            }
            return fetchPage(factory, location.path)
        }))
    return container
}