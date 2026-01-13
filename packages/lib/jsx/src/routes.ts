import {isDefined, Lazy, Notifier, Observer, Option, Subscription} from "@moises-ai/lib-std"

export class RouteLocation {
    @Lazy
    static get(): RouteLocation {return new RouteLocation()}

    readonly #notifier: Notifier<RouteLocation> = new Notifier<RouteLocation>()

    private constructor() {
        window.addEventListener("popstate", () => this.#notifier.notify(this))
        this.#setCanonical()
    }

    navigateTo(path: string): boolean {
        if (this.path === path) {
            return false
        }
        history.pushState(null, "", path)
        this.#setCanonical()
        this.#notifier.notify(this)
        return true
    }

    catchupAndSubscribe(observer: Observer<RouteLocation>): Subscription {
        observer(this)
        return this.#notifier.subscribe(observer)
    }

    get path(): string {return location.pathname}

    #setCanonical(): void {
        const url = location.href
        let link = document.querySelector("link[rel=\"canonical\"]")
        if (isDefined(link)) {
            link.setAttribute("href", url)
        } else {
            link = document.createElement("link")
            link.setAttribute("rel", "canonical")
            link.setAttribute("href", url)
            document.head.appendChild(link)
        }
    }
}

export type Route = { path: string }

export class RouteMatcher<R extends Route> {
    static create<R extends Route>(routes: ReadonlyArray<R>): RouteMatcher<R> {
        return new RouteMatcher<R>(routes)
    }

    static match(route: string, path: string): boolean {
        if (!path.startsWith("/") || !route.startsWith("/")) {
            return false
        }
        const routeSegments = route.split("/")
        const pathSegments = path.split("/")
        for (let i = 1; i < pathSegments.length; i++) {
            if (routeSegments[i] === "*") {
                return true
            }
            if (pathSegments[i] !== routeSegments[i]) {
                return false
            }
        }
        return true
    }

    readonly #routes: ReadonlyArray<R>

    private constructor(routes: ReadonlyArray<R>) {
        this.#routes = routes.toSorted((a: Route, b: Route) => {
            if (a.path < b.path) {
                return -1
            }
            if (a.path > b.path) {
                return 1
            }
            return 0
        })
    }

    resolve(path: string): Option<R> {
        return Option.wrap(this.#routes.find(route => RouteMatcher.match(route.path, path)))
    }
}