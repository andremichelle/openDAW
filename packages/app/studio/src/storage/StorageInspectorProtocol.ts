import {int, Procedure, unitValue} from "@opendaw/lib-std"
import {StorageScan} from "./StorageScan"

export interface StorageInspectorProtocol {
    scan(walkProgress: Procedure<int>, scanProgress: Procedure<unitValue>): Promise<StorageScan.Report>
}
