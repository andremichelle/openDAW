import trackCss from "./Track.sass?inline"
import headerCss from "./headers/TrackHeader.sass?inline"
import clipCss from "./clips/ClipLane.sass?inline"
import regionCss from "./regions/RegionLane.sass?inline"
import {Html} from "@opendaw/lib-dom"

/// One adoption per lane stylesheet: an audio unit's lanes, its synthetic lane and a modulator's lanes are
/// the same rows, so they share the sheets rather than adopting a copy each.
export const TrackClassName = Html.adoptStyleSheet(trackCss, "Track")
export const TrackHeaderClassName = Html.adoptStyleSheet(headerCss, "TrackHeader")
export const ClipLaneClassName = Html.adoptStyleSheet(clipCss, "ClipLane")
export const RegionLaneClassName = Html.adoptStyleSheet(regionCss, "RegionLane")
