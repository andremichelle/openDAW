import {spawnSync} from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// validates with the system xmllint (macOS, ubuntu-latest), a missing xmllint fails the test
export namespace XsdValidator {
    const xsdDirectory = path.resolve(__dirname, "../xsd")

    export const validate = (xml: string, schema: "Project" | "MetaData"): string => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dawproject-"))
        const file = path.join(directory, `${schema}.xml`)
        fs.writeFileSync(file, xml)
        const result = spawnSync("xmllint", ["--noout", "--schema", path.join(xsdDirectory, `${schema}.xsd`), file], {encoding: "utf-8"})
        fs.rmSync(directory, {recursive: true, force: true})
        if (result.error !== undefined) {return `xmllint failed: ${result.error.message}`}
        return result.status === 0 ? "valid" : result.stderr.split(file).join(schema).trim()
    }
}
