import {BoxGraph} from "@opendaw/lib-box"
import {asInstanceOf, isDefined, UUID} from "@opendaw/lib-std"
import {AudioUnitBox, BoxIO, TrackBox, UserInterfaceBox, ViewStateBox} from "@opendaw/studio-boxes"

type LegacyViewState = {target: AudioUnitBox | TrackBox, groupCollapsed: boolean, automationCollapsed: boolean, height: number}

export const migrateViewStates = (boxGraph: BoxGraph<BoxIO.TypeMap>, users: ReadonlyArray<UserInterfaceBox>): void => {
    const user = users.at(0)
    if (!isDefined(user)) {return}
    const owned = new Set(user.viewStates.pointerHub.incoming()
        .map(pointer => asInstanceOf(pointer.box, ViewStateBox).target.targetVertex.unwrapOrNull()?.box))
    const legacy: ReadonlyArray<LegacyViewState> = boxGraph.boxes().flatMap((box): ReadonlyArray<LegacyViewState> =>
        box instanceof AudioUnitBox ? [{
            target: box, groupCollapsed: box.groupCollapsed.getValue(),
            automationCollapsed: box.userInterface.automationCollapsed.getValue(), height: box.userInterface.height.getValue()
        }] : box instanceof TrackBox ? [{target: box, groupCollapsed: false, automationCollapsed: false, height: box.height.getValue()}] : [])
        .filter(state => !owned.has(state.target) && (state.groupCollapsed || state.automationCollapsed || state.height !== 0))
    if (legacy.length === 0) {return}
    boxGraph.beginTransaction()
    legacy.forEach(({target, groupCollapsed, automationCollapsed, height}) =>
        ViewStateBox.create(boxGraph, UUID.generate(), box => {
            box.target.refer(target)
            box.user.refer(user.viewStates)
            box.groupCollapsed.setValue(groupCollapsed)
            box.automationCollapsed.setValue(automationCollapsed)
            box.height.setValue(height)
        }))
    boxGraph.endTransaction()
}
