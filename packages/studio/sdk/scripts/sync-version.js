#!/usr/bin/env node

/**
 * Synchronizes the OPENDAW_SDK_VERSION constant with the package.json version.
 * This script is run automatically before publishing.
 */

import {readFileSync, writeFileSync} from "node:fs"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJsonPath = join(__dirname, "..", "package.json")
const versionFilePath = join(__dirname, "..", "src", "version.ts")

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"))
const version = packageJson.version

const versionFileContent = `/**
 * The current version of the OpenDAW SDK.
 * This value is automatically synchronized with package.json during publish.
 */
export const OPENDAW_SDK_VERSION = "${version}"
`

writeFileSync(versionFilePath, versionFileContent)
console.log(`Synchronized OPENDAW_SDK_VERSION to ${version}`)
