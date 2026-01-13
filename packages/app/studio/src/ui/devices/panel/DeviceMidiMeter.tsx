import css from "./DeviceMidiMeter.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement, DomElement} from "@moises-ai/lib-jsx"
import {Address} from "@moises-ai/lib-box"
import {LiveStreamReceiver} from "@moises-ai/lib-fusion"
import {Html} from "@moises-ai/lib-dom"
import {NoteStreamReceiver} from "@moises-ai/studio-adapters"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "DeviceMidiMeter")

type Construct = {
    lifecycle: Lifecycle
    receiver: LiveStreamReceiver
    address: Address
}

export const DeviceMidiMeter = ({lifecycle, receiver, address}: Construct) => {
    const size = 8
    const indicator: DomElement = (
        <circle cx={size / 2} cy={size / 2} r={size / 4} fill={Colors.shadow} visibility="hidden"/>
    )
    const streamReceiver = lifecycle.own(new NoteStreamReceiver(receiver, address))
    lifecycle.own(streamReceiver.subscribe(state =>
        indicator.style.visibility = state.isAnyNoteOn() ? "visible" : "hidden"))
    return (
        <svg classList={className} viewBox={`0 0 ${size} ${size}`} width={size} height={size}>{indicator}</svg>
    )
}