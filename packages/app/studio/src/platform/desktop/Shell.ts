import {asDefined, Exec, Nullable, Procedure} from "@opendaw/lib-std"

declare global {
    interface Window {
        __OPENDAW_SHELL__?: { token: string, api: number, menu?: Procedure<string>, close?: Exec }
    }
}

export namespace Shell {
    export type Body = BufferSource | Blob | string

    export const info = () => asDefined(window.__OPENDAW_SHELL__, "No desktop shell")

    export const request = async (command: string, params: Record<string, string>, body?: Nullable<Body>): Promise<Response> => {
        const response = await fetch(`/__shell/${command}?${new URLSearchParams(params)}`, {
            method: "POST", headers: {"X-Shell-Token": info().token}, body
        })
        if (response.status >= 400) {return Promise.reject(new Error(`${command} failed (${await response.text()})`))}
        return response
    }
}
