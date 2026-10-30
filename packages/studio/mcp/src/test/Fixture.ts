import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {afterEach} from "vitest"
import {ProjectSkeleton} from "@opendaw/studio-adapters"

const directories: Array<string> = []

afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, {recursive: true, force: true})))

export const temporaryDirectory = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "studio-mcp-"))
    directories.push(directory)
    return directory
}

export const emptyProject = (): ArrayBuffer =>
    ProjectSkeleton.encode(ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: true}).boxGraph) as ArrayBuffer
