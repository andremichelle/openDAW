import {Lifecycle, Terminator, UUID} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {AudioBusBoxAdapter, AudioUnitBoxAdapter, ColorCodes} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon.tsx"
import {StudioService} from "@/service/StudioService"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    audioUnitBoxAdapter: AudioUnitBoxAdapter
}

// Every lane of a unit carries the unit's own instrument icon, on the track headers as well as on the
// synthetic unit lane. A track-type icon would only repeat what the lane content already shows.
// TracksManager hides it on the unit's repeated lanes ("repeat-icon").
export const TrackIcon = ({lifecycle, service, audioUnitBoxAdapter}: Construct) => {
    const {audioUnitFreeze} = service.project
    const element: HTMLElement = <div className="icon-container"/>
    const lockIcon: HTMLElement = <Icon symbol={IconSymbol.Lock} className="lock-icon"/>
    const updateFrozenState = () =>
        lockIcon.classList.toggle("hidden", !audioUnitFreeze.isFrozen(audioUnitBoxAdapter))
    updateFrozenState()
    const iconLifecycle = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        // The icon keeps the unit's color: an instrument its type color (green), a bus its OWN color field.
        audioUnitBoxAdapter.input.catchupAndSubscribe(optAdapter => {
            iconLifecycle.terminate()
            optAdapter.match({
                none: () => replaceChildren(element, <Icon symbol={IconSymbol.AudioBus}/>, lockIcon),
                some: inputAdapter => {
                    const render = () => {
                        const symbol = IconSymbol.fromName(inputAdapter.iconField.getValue())
                        const color = inputAdapter instanceof AudioBusBoxAdapter
                            ? inputAdapter.colorField.getValue()
                            : ColorCodes.forAudioType(audioUnitBoxAdapter.type).toString()
                        replaceChildren(element, <Icon symbol={symbol} style={{color}}/>, lockIcon)
                    }
                    iconLifecycle.own(inputAdapter.iconField.catchupAndSubscribe(render))
                    if (inputAdapter instanceof AudioBusBoxAdapter) {
                        iconLifecycle.own(inputAdapter.colorField.subscribe(render))
                    }
                }
            })
        }),
        audioUnitFreeze.subscribe((uuid: UUID.Bytes) => {
            if (UUID.equals(uuid, audioUnitBoxAdapter.uuid)) {updateFrozenState()}
        })
    )
    return element
}
