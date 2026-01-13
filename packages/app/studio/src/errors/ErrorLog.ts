import {int} from "@moises-ai/lib-std"
import {BuildInfo} from "@/BuildInfo.ts"
import {LogBuffer} from "@/errors/LogBuffer.ts"
import {ErrorInfo} from "@/errors/ErrorInfo.ts"

export type ErrorLog = {
    date: string
    agent: string
    build: BuildInfo
    scripts: int
    error: ErrorInfo
    logs: Array<LogBuffer.Entry>
}