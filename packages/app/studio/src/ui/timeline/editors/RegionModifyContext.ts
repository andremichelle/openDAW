import {Notifier, Observer, Option, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {AnyRegionBoxAdapter} from "@opendaw/studio-adapters"
import {RegionModifyStrategies, RegionModifyStrategy} from "@opendaw/studio-core"
import {Dragging} from "@opendaw/lib-dom"
import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier.ts"

type Running = {
    region: AnyRegionBoxAdapter
    modifier: RegionModifier
}

export class RegionModifyContext implements Terminable {
    static readonly Idle = new RegionModifyContext()

    readonly #notifier: Notifier<void>

    #running: Option<Running> = Option.None

    constructor() {
        this.#notifier = new Notifier<void>()
    }

    subscribeUpdate(observer: Observer<void>): Subscription {return this.#notifier.subscribe(observer)}

    isModifying(region: AnyRegionBoxAdapter): boolean {
        return this.#running.match({none: () => false, some: running => running.region === region})
    }

    strategies(): RegionModifyStrategies {
        return this.#running.match({
            none: () => RegionModifyStrategies.Identity,
            some: ({modifier}) => modifier
        })
    }

    strategyFor(region: AnyRegionBoxAdapter): RegionModifyStrategy {
        const strategies = this.strategies()
        return this.isModifying(region)
            ? strategies.selectedModifyStrategy()
            : strategies.unselectedModifyStrategy()
    }

    startModifier(region: AnyRegionBoxAdapter, option: Option<RegionModifier>): Option<Dragging.Process> {
        return option.map(modifier => {
            const lifeTime = new Terminator()
            lifeTime.own({
                terminate: () => {
                    this.#running = Option.None
                    this.#notifier.notify()
                }
            })
            this.#running = Option.wrap({region, modifier})
            return {
                update: (event: Dragging.Event): void => {
                    modifier.update(event)
                    this.#notifier.notify()
                },
                approve: (): void => modifier.approve(),
                cancel: (): void => modifier.cancel(),
                finally: (): void => lifeTime.terminate()
            }
        })
    }

    terminate(): void {this.#notifier.terminate()}
}