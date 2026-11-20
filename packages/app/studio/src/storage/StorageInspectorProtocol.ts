import {int, Procedure, unitValue} from "@opendaw/lib-std"
import type {StorageScan} from "@opendaw/studio-core/StorageScan"
import {SampleFormats} from "./SampleFormats"

export interface StorageInspectorProtocol {
    scan(walkProgress: Procedure<int>, scanProgress: Procedure<unitValue>): Promise<StorageScan.Report>
    scanSampleFormats(progress: Procedure<unitValue>): Promise<SampleFormats.Report>
}
