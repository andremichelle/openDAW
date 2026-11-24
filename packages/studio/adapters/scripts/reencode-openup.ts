// Re-encodes openup.od with the current schema (fields added since are written with their defaults, deprecated ones dropped).
import {readFileSync, writeFileSync} from "node:fs"
import {ProjectSkeleton} from "../src/project/ProjectSkeleton"

const path = "../../../test-files/openup.od"
const buffer = readFileSync(path)
const {boxGraph} = ProjectSkeleton.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
writeFileSync(path, new Uint8Array(ProjectSkeleton.encode(boxGraph)))
