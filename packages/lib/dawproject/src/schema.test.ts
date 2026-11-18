// @vitest-environment node
import {describe, expect, it} from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import {SchemaGenerator} from "../generator/SchemaGenerator"

const read = (file: string): string => fs.readFileSync(path.resolve(__dirname, file), "utf-8")

describe("generated schema", () => {
    it("matches Project.xsd and MetaData.xsd", () => {
        const generated = SchemaGenerator.generate([read("../xsd/Project.xsd"), read("../xsd/MetaData.xsd")])
        if (process.env.UPDATE_SCHEMA === "1") {fs.writeFileSync(path.resolve(__dirname, "schema.ts"), generated)}
        expect(read("schema.ts")).toBe(generated)
    })
})
