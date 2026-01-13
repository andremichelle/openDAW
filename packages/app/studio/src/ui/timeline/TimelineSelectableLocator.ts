import {Coordinates, SelectableLocator} from "@moises-ai/lib-std"
import {ppqn} from "@moises-ai/lib-dsp"

import {BoxAdapter} from "@moises-ai/studio-adapters"

export type TimelineCoordinates = Coordinates<ppqn, number>
export type TimelineSelectableLocator<A extends BoxAdapter> = SelectableLocator<A, ppqn, number>