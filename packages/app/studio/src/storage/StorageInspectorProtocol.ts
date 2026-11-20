import {int, Procedure, unitValue} from "@opendaw/lib-std"
import type {StorageScan} from "@opendaw/studio-core/StorageScan"

export interface StorageInspectorProtocol {
    scan(walkProgress: Procedure<int>, scanProgress: Procedure<unitValue>): Promise<StorageScan.Report>
}
