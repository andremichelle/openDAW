// Prints the TS BoxGraph.checksum() of openup.od (32 bytes) to cross-validate the Rust checksum.
import {readFileSync} from "node:fs"
import {ProjectSkeleton} from "../src/project/ProjectSkeleton"

const buffer = readFileSync("../../../test-files/openup.od")
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
const {boxGraph} = ProjectSkeleton.decode(arrayBuffer)
const checksum = boxGraph.checksum()
console.log("CHECKSUM", Array.from(checksum, byte => (byte & 0xff).toString(16).padStart(2, "0")).join(""))
