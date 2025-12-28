import {
    clamp,
    int,
    Notifier,
    Observable,
    Observer,
    Option,
    quantizeCeil,
    quantizeFloor,
    quantizeRound,
    Subscription,
    Terminable
} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {TimelineRange} from "@opendaw/studio-core"
import {MenuItem, MenuRootData} from "@/ui/model/menu-item"
import {SignatureTrackAdapter} from "@opendaw/studio-adapters"

export interface SnapUnit {
    get name(): string
    ppqn(position: ppqn): int
}

const SMART_MIN_PIXEL = 16 as const

export class Snapping implements Observable<Snapping> {
    static readonly createMenuRoot = (snapping: Snapping): MenuItem<MenuRootData> => MenuItem.root()
        .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...snapping.units
            .map((unit: SnapUnit, index: int) => MenuItem.default({label: unit.name, checked: unit === snapping.unit})
                .setTriggerProcedure(() => snapping.index = index))))

    readonly #range: TimelineRange
    readonly #units: ReadonlyArray<SnapUnit>
    readonly #notifier: Notifier<Snapping>

    #optSignatureTrack: Option<SignatureTrackAdapter> = Option.None

    #enabled: boolean = true
    #index: int = 0 | 0

    constructor(range: TimelineRange) {
        this.#range = range
        this.#units = this.#initUnits()
        this.#notifier = new Notifier<Snapping>()
    }

    subscribe(observer: Observer<Snapping>): Subscription {return this.#notifier.subscribe(observer)}
    catchupAndSubscribe(observer: Observer<Snapping>): Subscription {
        observer(this)
        return this.#notifier.subscribe(observer)
    }

    terminate(): void {this.#notifier.terminate()}

    get unit(): SnapUnit {return this.#units[this.#index]}
    get enabled(): boolean {return this.#enabled}
    get index(): int {return this.#index}
    set index(value: int) {
        if (this.#index === value) {return}
        this.#index = value
        this.#notifier.notify(this)
    }
    get units(): ReadonlyArray<SnapUnit> {return this.#units}
    value(position: ppqn): ppqn {return this.#enabled ? this.#units[this.#index].ppqn(position) : 1}

    #signatureAt(position: ppqn): Readonly<[int, int]> {
        return this.#optSignatureTrack.mapOr(adapter => adapter.signatureAt(position), [4, 4])
    }

    registerSignatureTrackAdapter(adapter: SignatureTrackAdapter): Subscription {
        this.#optSignatureTrack = Option.wrap(adapter)
        return Terminable.create(() => this.#optSignatureTrack = Option.None)
    }

    xToUnitFloor(x: number): ppqn {return this.floor(this.#range.xToUnit(x))}
    xToUnitCeil(x: number): ppqn {return this.ceil(this.#range.xToUnit(x))}
    xToUnitRound(x: number): ppqn {return this.round(this.#range.xToUnit(x))}

    floor(position: ppqn): ppqn {
        if (this.#optSignatureTrack.nonEmpty()) {
            const adapter = this.#optSignatureTrack.unwrap()
            if (this.value(position) === adapter.barLengthAt(position)) {
                return adapter.floorToBar(position)
            }
        }
        return quantizeFloor(position, this.value(position))
    }

    round(position: ppqn): ppqn {
        if (this.#optSignatureTrack.nonEmpty()) {
            const adapter = this.#optSignatureTrack.unwrap()
            if (this.value(position) === adapter.barLengthAt(position)) {
                return adapter.roundToBar(position)
            }
        }
        return quantizeRound(position, this.value(position))
    }

    ceil(position: ppqn): ppqn {
        if (this.#optSignatureTrack.nonEmpty()) {
            const adapter = this.#optSignatureTrack.unwrap()
            if (this.value(position) === adapter.barLengthAt(position)) {
                return adapter.ceilToBar(position)
            }
        }
        return quantizeCeil(position, this.value(position))
    }

    computeDelta(beingPointerPulse: ppqn, newPointerX: number, beginValuePulse: ppqn): ppqn {
        const pointerTicks = this.#range.xToUnit(newPointerX) - (beingPointerPulse - beginValuePulse)
        const localDelta = this.round(pointerTicks - beginValuePulse)
        const globalDelta = this.round(pointerTicks) - beginValuePulse
        const localDistance = Math.abs((beginValuePulse + localDelta) - pointerTicks)
        const globalDistance = Math.abs((beginValuePulse + globalDelta) - pointerTicks)
        return localDistance < globalDistance ? localDelta : globalDelta
    }

    #initUnits() {
        const range: TimelineRange = this.#range
        const scope = this
        return [
            {
                name: "Smart",
                ppqn: (position: ppqn): int => {
                    const [nominator, denominator] = scope.#signatureAt(position)
                    const barPulses = PPQN.fromSignature(nominator, denominator)
                    const beatPulses = PPQN.fromSignature(1, denominator)
                    const minUnits = SMART_MIN_PIXEL * range.unitsPerPixel
                    // Start from the finest resolution
                    let interval = PPQN.fromSignature(1, 128)
                    // Scale up using the same logic as TimeGrid
                    while (interval < minUnits) {
                        if (interval < beatPulses) {
                            // Below beat level: multiply by 2
                            const nextInterval = interval * 2
                            if (nextInterval > beatPulses) {
                                interval = beatPulses
                            } else {
                                interval = nextInterval
                            }
                        } else if (interval < barPulses) {
                            // Between beat and bar level: multiply by nominator
                            const nextInterval = interval * nominator
                            if (nextInterval > barPulses) {
                                interval = barPulses
                            } else {
                                interval = nextInterval
                            }
                        } else {
                            // At or above bar level: don't go beyond a single bar for snapping
                            break
                        }
                    }

                    const clampSmartSnapping = true
                    const min = clampSmartSnapping
                        ? PPQN.fromSignature(1, 16)
                        : PPQN.fromSignature(1, 128)
                    // Clamp between min and bar level
                    return clamp(Math.floor(interval), min, barPulses)
                }
            },
            {
                name: "Bar",
                ppqn: (position: ppqn): int => {
                    const [nominator, denominator] = scope.#signatureAt(position)
                    return PPQN.fromSignature(nominator, denominator)
                }
            },
            {name: "1/2", ppqn: (_position: ppqn): int => PPQN.fromSignature(1, 2)},
            {name: "1/4", ppqn: (_position: ppqn): int => PPQN.fromSignature(1, 4)},
            {name: "1/8", ppqn: (_position: ppqn): int => PPQN.fromSignature(1, 8)},
            {name: "1/8T", ppqn: (_position: ppqn): int => PPQN.fromSignature(1, 4) / 3},
            {name: "1/16", ppqn: (_position: ppqn): int => PPQN.fromSignature(1, 16)},
            {name: "1/16T", ppqn: (_position: ppqn): int => PPQN.fromSignature(1, 8) / 3},
            {name: "1/32", ppqn: (_position: ppqn): int => PPQN.fromSignature(1, 32)},
            {name: "1/32T", ppqn: (_position: ppqn): int => PPQN.fromSignature(1, 16) / 3},
            {name: "1/64", ppqn: (_position: ppqn): int => PPQN.fromSignature(1, 64)},
            {name: "1/128", ppqn: (_position: ppqn): int => PPQN.fromSignature(1, 128)},
            {name: "Off", ppqn: (_position: ppqn): int => 1}
        ]
    }
}