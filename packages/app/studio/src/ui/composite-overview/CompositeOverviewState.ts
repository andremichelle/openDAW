import {Nullable} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {CompositeCell, DeviceBoxAdapter, IndexedBoxAdapter, IndexedBoxAdapterCollection} from "@opendaw/studio-adapters"
import {Workspace} from "@/ui/workspace/Workspace"

export type CompositeOverviewState = Readonly<{
    type: "composite"
    composite: DeviceBoxAdapter
    cells: IndexedBoxAdapterCollection<IndexedBoxAdapter & CompositeCell, Pointers>
    previousScreen: Nullable<Workspace.ScreenKeys>
}>
