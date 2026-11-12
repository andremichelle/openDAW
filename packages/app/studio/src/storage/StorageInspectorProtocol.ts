import {int, Procedure, unitValue} from "@opendaw/lib-std"
import {StorageScan} from "./StorageScan"
import {SampleFormats} from "./SampleFormats"

export interface StorageInspectorProtocol {
    scan(walkProgress: Procedure<int>, scanProgress: Procedure<unitValue>): Promise<StorageScan.Report>
    scanSampleFormats(progress: Procedure<unitValue>): Promise<SampleFormats.Report>
}
