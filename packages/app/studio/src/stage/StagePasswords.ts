import {isDefined, Option} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {StageClient} from "@/stage/StageClient"

// The Credential Management API for passwords exists in Chromium only and is not part of the TypeScript DOM types
export namespace StagePasswords {
    type PasswordCredentialData = Readonly<{ id: string, password: string, name: string }>
    type PasswordCredentialClass = new (data: PasswordCredentialData) => Credential
    type PasswordRequestOptions = CredentialRequestOptions & Readonly<{ password: boolean }>

    const passwordCredentialClass = (): Option<PasswordCredentialClass> => {
        const value: unknown = Reflect.get(globalThis, "PasswordCredential")
        return typeof value === "function" && isDefined(navigator.credentials)
            ? Option.wrap(value as PasswordCredentialClass)
            : Option.None
    }

    export const isSupported = (): boolean => passwordCredentialClass().nonEmpty()

    export const recall = async (): Promise<Option<StageClient.Credentials>> => {
        if (!isSupported()) {return Option.None}
        const options: PasswordRequestOptions = {password: true, mediation: "optional"}
        const result = await Promises.tryCatch(navigator.credentials.get(options))
        if (result.status === "rejected" || !isDefined(result.value)) {return Option.None}
        const credential = result.value
        const password: unknown = Reflect.get(credential, "password")
        if (typeof password !== "string" || password.length === 0) {return Option.None}
        return StageClient.normalizeUrl(credential.id).map(url => ({url, token: password}))
    }

    export const remember = async ({url, token}: StageClient.Credentials): Promise<void> => {
        const PasswordCredential = passwordCredentialClass()
        if (PasswordCredential.isEmpty()) {return}
        const credential = new (PasswordCredential.unwrap())({id: url, password: token, name: "openDAW Stage"})
        await Promises.tryCatch(navigator.credentials.store(credential))
    }
}
