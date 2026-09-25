import {Editing, Errors, isDefined, isNull, Nullable, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {NeuralAmpModelBox} from "@opendaw/studio-boxes"
import {BoxGraph} from "@opendaw/lib-box"
import {NeuralAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Workers} from "@opendaw/studio-core"
import {showTone3000Dialog} from "./Tone3000Dialog"

type Tone = { id: number, title: string, updated_at: string }
type Model = { id: number, name: string, size: string, model_url: string }
type PaginatedResponse<T> = { data: ReadonlyArray<T>, page: number, page_size: number, total: number, total_pages: number }
type Session = { access_token: string, refresh_token: string, expires_in: number }
type CallbackMessage =
    | {
    type: "callback", code: Nullable<string>, state: Nullable<string>, toneId: Nullable<string>,
    canceled: boolean, error: Nullable<string>, errorDescription: Nullable<string>
}
    | { type: "closed" }

export type PackMeta = {
    toneId: number
    title: string
    updatedAt: string
    models: ReadonlyArray<Model>
}

const ClientId = "t3k_pub_txvY3hFE8w6GJYvSW69eMOeBioJRZWKk"
const ApiBase = "https://www.tone3000.com/api/v1"
const AuthorizeEndpoint = `${ApiBase}/oauth/authorize`
const TokenEndpoint = `${ApiBase}/oauth/token`
const ChannelName = "tone3000-callback"
const AccessTokenKey = "tone3000_access_token"
const RefreshTokenKey = "tone3000_refresh_token"
const ExpiresAtKey = "tone3000_expires_at"
const ExpiryMargin = 60_000
const ModelsPageSize = 300
const Architecture = "2"

const packPath = (toneId: number): string => `tone3000/${toneId}`
const packMetaPath = (toneId: number): string => `${packPath(toneId)}/pack.json`
const modelPath = (toneId: number, modelId: number): string => `${packPath(toneId)}/models/${modelId}.nam`

const base64Url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")

const createPkceCodes = async (): Promise<{ codeVerifier: string, codeChallenge: string }> => {
    const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))
    return {codeVerifier, codeChallenge: base64Url(new Uint8Array(digest))}
}

const storeSession = ({access_token, refresh_token, expires_in}: Session): void => {
    localStorage.setItem(AccessTokenKey, access_token)
    localStorage.setItem(RefreshTokenKey, refresh_token)
    localStorage.setItem(ExpiresAtKey, String(Date.now() + expires_in * 1000))
}

const clearSession = (): void => {
    localStorage.removeItem(AccessTokenKey)
    localStorage.removeItem(RefreshTokenKey)
    localStorage.removeItem(ExpiresAtKey)
}

export const hasSession = (): boolean => isDefined(localStorage.getItem(RefreshTokenKey))

const requestToken = async (params: Record<string, string>): Promise<Session> => {
    const response = await fetch(TokenEndpoint, {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: new URLSearchParams({...params, client_id: ClientId})
    })
    if (!response.ok) {throw new Error(`TONE3000 token request failed: ${response.status}`)}
    const session: Session = await response.json()
    storeSession(session)
    return session
}

const accessToken = async (): Promise<string> => {
    const token = localStorage.getItem(AccessTokenKey)
    const expiresAt = parseInt(localStorage.getItem(ExpiresAtKey) ?? "0", 10)
    if (isDefined(token) && Date.now() < expiresAt - ExpiryMargin) {return token}
    const refreshToken = localStorage.getItem(RefreshTokenKey)
    if (!isDefined(refreshToken)) {throw new Error("Not signed in to TONE3000 — re-select pack")}
    const result = await Promises.tryCatch(requestToken({grant_type: "refresh_token", refresh_token: refreshToken}))
    if (result.status === "rejected") {
        clearSession()
        throw new Error("TONE3000 session expired — re-select pack")
    }
    return result.value.access_token
}

const apiFetch = async (url: string, signal?: AbortSignal): Promise<Response> => {
    const token = await accessToken()
    const response = await fetch(url, {headers: {Authorization: `Bearer ${token}`}, signal})
    if (response.status === 401) {clearSession()}
    if (!response.ok) {throw new Error(`TONE3000 request failed: ${response.status}`)}
    return response
}

const fetchTone = async (toneId: string): Promise<Tone> =>
    (await apiFetch(`${ApiBase}/tones/${toneId}?architecture=${Architecture}`)).json()

const fetchModels = async (toneId: string): Promise<ReadonlyArray<Model>> => {
    const models: Array<Model> = []
    for (let page = 1, totalPages = 1; page <= totalPages; page++) {
        const url = `${ApiBase}/models?tone_id=${toneId}&page=${page}&page_size=${ModelsPageSize}&architecture=${Architecture}`
        const response: PaginatedResponse<Model> = await (await apiFetch(url)).json()
        models.push(...response.data)
        totalPages = response.total_pages
    }
    return models
}

const downloadModel = async (modelUrl: string, signal?: AbortSignal): Promise<string> =>
    (await apiFetch(modelUrl, signal)).text()

const selectTone = async (): Promise<string> => {
    const redirectUri = `${location.origin}/tone3000-callback.html`
    const {codeVerifier, codeChallenge} = await createPkceCodes()
    const state = crypto.randomUUID()
    const params = new URLSearchParams({
        client_id: ClientId,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        prompt: "select_tone",
        format: "nam",
        architecture: Architecture,
        menubar: "true",
        preview: "true"
    })
    const authWindow = window.open(`${AuthorizeEndpoint}?${params}`, "tone3000")
    if (isNull(authWindow)) {return Errors.warn("Failed to open TONE3000 window. Please check popup blockers.")}
    const {resolve, reject, promise} = Promise.withResolvers<string>()
    const channel = new BroadcastChannel(ChannelName)
    let handled = false
    channel.onmessage = async (event: MessageEvent<CallbackMessage>) => {
        const message = event.data
        if (handled || message.type === "closed") {return}
        handled = true
        if (message.state !== state) {return reject(new Error("TONE3000 state mismatch"))}
        if (message.canceled) {return reject(Errors.AbortError)}
        if (isDefined(message.error)) {
            return reject(new Error(`TONE3000 authorization failed: ${message.error} — ${message.errorDescription ?? ""}`))
        }
        const {code, toneId} = message
        if (!isDefined(code) || !isDefined(toneId)) {return reject(new Error("TONE3000 returned no tone"))}
        const result = await Promises.tryCatch(requestToken({
            grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri
        }))
        if (result.status === "rejected") {reject(result.error)} else {resolve(toneId)}
    }
    return promise.finally(() => {
        authWindow.close()
        channel.close()
    })
}

const readPackMeta = async (toneId: number): Promise<Nullable<PackMeta>> => {
    const path = packMetaPath(toneId)
    if (!await Workers.Opfs.exists(path)) {return null}
    const bytes = await Workers.Opfs.read(path)
    return JSON.parse(new TextDecoder().decode(bytes))
}

export const readPackMetaFromId = async (packId: string): Promise<Nullable<PackMeta>> => {
    const toneId = parseInt(packId, 10)
    if (isNaN(toneId)) {return null}
    return readPackMeta(toneId)
}

export const readModelFromPack = async (packId: string, modelId: number, signal?: AbortSignal): Promise<string> => {
    const toneId = parseInt(packId, 10)
    const path = modelPath(toneId, modelId)
    if (await Workers.Opfs.exists(path)) {
        const bytes = await Workers.Opfs.read(path)
        return new TextDecoder().decode(bytes)
    }
    const meta = await readPackMeta(toneId)
    if (isNull(meta)) {throw new Error("Pack metadata not found")}
    const entry = meta.models.find(entry => entry.id === modelId)
    if (!isDefined(entry) || entry.model_url.length === 0) {
        throw new Error("Model URL not available — re-select pack")
    }
    const text = await downloadModel(entry.model_url, signal)
    await Workers.Opfs.write(path, new TextEncoder().encode(text))
    return text
}

const storePackToOpfs = async (tone: Tone, models: ReadonlyArray<Model>): Promise<PackMeta> => {
    const toneId = tone.id
    const existingMeta = await readPackMeta(toneId)
    if (isDefined(existingMeta) && existingMeta.updatedAt !== tone.updated_at) {
        const newModelIds = new Set(models.map(model => model.id))
        for (const model of existingMeta.models) {
            if (!newModelIds.has(model.id) && await Workers.Opfs.exists(modelPath(toneId, model.id))) {
                await Workers.Opfs.delete(modelPath(toneId, model.id))
            }
        }
    }
    const meta: PackMeta = {
        toneId,
        title: tone.title,
        updatedAt: tone.updated_at,
        models: models.map(({id, name, size, model_url}) => ({id, name, size, model_url}))
    }
    await Workers.Opfs.write(packMetaPath(toneId), new TextEncoder().encode(JSON.stringify(meta)))
    const defaultModel = pickDefaultModel(meta)
    if (!await Workers.Opfs.exists(modelPath(toneId, defaultModel.id))) {
        const text = await downloadModel(defaultModel.model_url)
        await Workers.Opfs.write(modelPath(toneId, defaultModel.id), new TextEncoder().encode(text))
    }
    return meta
}

const pickDefaultModel = (meta: PackMeta): Model => {
    const standard = meta.models.find(model => model.size === "standard")
    return standard ?? meta.models[0]
}

export const scanCachedModels = async (packId: string, meta: PackMeta): Promise<ReadonlySet<number>> => {
    const toneId = parseInt(packId, 10)
    if (isNaN(toneId)) {return new Set()}
    const entries = await Workers.Opfs.list(`${packPath(toneId)}/models`)
        .catch(() => [] as ReadonlyArray<{ name: string, kind: string }>)
    const fileNames = new Set(entries.filter(entry => entry.kind === "file").map(entry => entry.name))
    const cached = new Set<number>()
    for (const model of meta.models) {
        if (fileNames.has(`${model.id}.nam`)) {cached.add(model.id)}
    }
    return cached
}

const referModel = async (boxGraph: BoxGraph, editing: Editing, adapter: NeuralAmpDeviceBoxAdapter,
                          text: string, label: string, packId: string): Promise<void> => {
    const jsonBuffer = new TextEncoder().encode(text)
    const uuid = await UUID.sha256(jsonBuffer.buffer as ArrayBuffer)
    editing.modify(() => {
        const oldTarget = adapter.box.model.targetVertex
        const modelBox = boxGraph.findBox<NeuralAmpModelBox>(uuid).unwrapOrElse(() =>
            NeuralAmpModelBox.create(boxGraph, uuid, box => {
                box.label.setValue(label)
                box.model.setValue(text)
                box.packId.setValue(packId)
            }))
        adapter.box.model.refer(modelBox)
        if (oldTarget.nonEmpty()) {
            const oldVertex = oldTarget.unwrap()
            if (oldVertex !== modelBox && oldVertex.pointerHub.isEmpty()) {
                oldVertex.box.unstage()
            }
        }
    })
}

const loadSelectedTone = async (boxGraph: BoxGraph, editing: Editing, adapter: NeuralAmpDeviceBoxAdapter): Promise<void> => {
    const toneId = await selectTone()
    const [tone, models] = await Promise.all([fetchTone(toneId), fetchModels(toneId)])
    if (models.length === 0) {return}
    const meta = await storePackToOpfs(tone, models)
    const defaultModel = pickDefaultModel(meta)
    const packId = meta.toneId.toString()
    const text = await readModelFromPack(packId, defaultModel.id)
    await referModel(boxGraph, editing, adapter, text, `${meta.title} — ${defaultModel.name}`, packId)
}

export namespace NamTone3000 {
    export const browse = (boxGraph: BoxGraph, editing: Editing, adapter: NeuralAmpDeviceBoxAdapter) => async () => {
        if (!hasSession()) {
            const {status} = await Promises.tryCatch(showTone3000Dialog())
            if (status === "rejected") {return}
        }
        const result = await Promises.tryCatch(loadSelectedTone(boxGraph, editing, adapter))
        if (result.status === "rejected" && !Errors.isAbort(result.error)) {
            console.error("Failed to load NAM model from TONE3000:", result.error)
            const {error} = result
            await RuntimeNotifier.info({headline: "TONE3000", message: error instanceof Error ? error.message : String(error)})
        }
    }

    export const loadModelFromPack = async (
        packId: string, modelId: number, modelName: string,
        boxGraph: BoxGraph, editing: Editing, adapter: NeuralAmpDeviceBoxAdapter,
        packTitle: string, signal?: AbortSignal
    ): Promise<void> => {
        const text = await readModelFromPack(packId, modelId, signal)
        await referModel(boxGraph, editing, adapter, text, `${packTitle} — ${modelName}`, packId)
    }
}
