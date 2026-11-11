import css from "./DeviceMidiMeter.sass?inline"
import {int, Lifecycle, Option, Provider} from "@opendaw/lib-std"
import {createElement, DomElement} from "@opendaw/lib-jsx"
import {Address} from "@opendaw/lib-box"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {Html} from "@opendaw/lib-dom"
import {NoteStreamReceiver} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "DeviceMidiMeter")

type Construct = {
    lifecycle: Lifecycle
    receiver: LiveStreamReceiver
    address: Address
    onlyKey?: Provider<Option<int>> // a Playfield pad hears only its own key
}

export const DeviceMidiMeter = ({lifecycle, receiver, address, onlyKey}: Construct) => {
    const size = 8
    const indicator: DomElement = (
        <circle cx={size / 2} cy={size / 2} r={size / 4} fill={Colors.shadow} visibility="hidden"/>
    )
    const streamReceiver = lifecycle.own(new NoteStreamReceiver(receiver, address))
    lifecycle.own(streamReceiver.subscribe(state =>
        indicator.style.visibility = (onlyKey?.() ?? Option.None)
            .mapOr(key => state.isNoteOn(key), state.isAnyNoteOn()) ? "visible" : "hidden"))
    return (
        <svg classList={className} viewBox={`0 0 ${size} ${size}`} width={size} height={size}>{indicator}</svg>
    )
}