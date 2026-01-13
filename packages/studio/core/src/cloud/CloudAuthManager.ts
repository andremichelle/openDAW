import {asDefined, Errors, isDefined, isNull, Maps, panic, RuntimeNotifier, TimeSpan} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {CloudService} from "./CloudService"
import {CloudHandler} from "./CloudHandler"
import {DropboxHandler} from "./DropboxHandler"
import {GoogleDriveHandler} from "./GoogleDriveHandler"

type ClientIds = {
    Dropbox: string
    GoogleDrive: string
}

export class CloudAuthManager {
    static create(clientIds: ClientIds): CloudAuthManager {return new CloudAuthManager(clientIds)}

    static async #createCodes(): Promise<{ codeVerifier: string; codeChallenge: string }> {
        const array = new Uint8Array(32)
        crypto.getRandomValues(array)
        const codeVerifier = btoa(String.fromCharCode(...array))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, "")
        const encoder = new TextEncoder()
        const data = encoder.encode(codeVerifier)
        const digest = await crypto.subtle.digest("SHA-256", data)
        const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, "")
        return {codeVerifier, codeChallenge}
    }

    readonly #clientIds: ClientIds

    readonly #memoizedHandlers = new Map<CloudService, () => Promise<CloudHandler>>()

    private constructor(clientIds: ClientIds) {this.#clientIds = clientIds}

    async getHandler(service: CloudService): Promise<CloudHandler> {
        const memo = Maps.createIfAbsent(this.#memoizedHandlers, service, service => {
            switch (service) {
                case "Dropbox": {
                    return Promises.memoizeAsync(this.#oauthDropbox.bind(this), TimeSpan.hours(1))
                }
                case "GoogleDrive": {
                    return Promises.memoizeAsync(this.#oauthGoogle.bind(this), TimeSpan.hours(1))
                }
                default:
                    return panic(`Unsupported service: ${service}`)
            }
        })
        const handler = await memo()
        const {status, error} = await Promises.tryCatch(handler.alive())
        if (status === "rejected") {
            // Do not auto-retry here to avoid reopening the OAuth popup in a loop.
            // Instead, clear the memoized handler and surface the error to the caller.
            this.#memoizedHandlers.delete(service)
            return Promise.reject(error)
        }
        console.debug(`Handler for '${service}' is alive`)
        return handler
    }

    async #oauthPkceFlow(config: {
        service: string
        clientId: string
        authUrlBase: string
        tokenUrl: string
        scope: string
        extraAuthParams?: Record<string, string>
        extraTokenParams?: Record<string, string>
    }): Promise<CloudHandler> {
        const redirectUri = `${location.origin}/auth-callback.html`
        const {codeVerifier, codeChallenge} = await CloudAuthManager.#createCodes()
        const params = new URLSearchParams({
            client_id: config.clientId,
            response_type: "code",
            redirect_uri: redirectUri,
            scope: config.scope,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            ...(config.extraAuthParams ?? {})
        })
        const authUrl = `${config.authUrlBase}?${params.toString()}`
        console.debug("[CloudAuth] Opening auth window:", authUrl)
        const authWindow = window.open(authUrl, "cloudAuth")
        if (isNull(authWindow)) {
            return Errors.warn("Failed to open authentication window. Please check popup blockers.")
        }
        const {resolve, reject, promise} = Promise.withResolvers<CloudHandler>()
        const channel = new BroadcastChannel("auth-callback")
        const dialog = RuntimeNotifier.progress({
            headline: "Cloud Service",
            message: "Please wait for authentication...",
            cancel: () => reject("cancelled")
        })
        let handled = false
        channel.onmessage = async (event: MessageEvent<any>) => {
            const data = asDefined(event.data, "No data")
            console.debug("[CloudAuth] Received via BroadcastChannel")
            if (data.type === "auth-callback" && isDefined(data.code)) {
                if (handled) {return}
                handled = true
                console.debug("[CloudAuth] Processing code from BroadcastChannel...", data.type, data.code)
                try {
                    const tokenParams = new URLSearchParams({
                        code: data.code,
                        grant_type: "authorization_code",
                        client_id: config.clientId,
                        redirect_uri: redirectUri,
                        code_verifier: codeVerifier,
                        ...(config.extraTokenParams ?? {})
                    })
                    const response = await fetch(config.tokenUrl, {
                        method: "POST",
                        headers: {"Content-Type": "application/x-www-form-urlencoded"},
                        body: tokenParams.toString()
                    })
                    if (!response.ok) {
                        const errorText = await response.text()
                        console.error("[CloudAuth] Token exchange error:", errorText)
                        return panic(`Token exchange failed: ${errorText}`)
                    }
                    const dataJson = await response.json()
                    const accessToken = dataJson.access_token
                    if (!accessToken) {
                        return panic("No access_token in token response")
                    }
                    resolve(await this.#createHandler(config.service, accessToken))
                } catch (err) {
                    console.debug("[CloudAuth] Token exchange failed:", err)
                    reject(err)
                }
            } else if (data.type === "closed") {
                // Only reject if we did not already start handling a code
                if (!handled) {
                    console.debug("[CloudAuth] Callback window closed before code received")
                    reject(null)
                }
            }
        }
        return promise.finally(() => {
            console.debug("[CloudAuth] Closing auth window")
            authWindow.close()
            dialog.terminate()
            channel.close()
        })
    }

    async #oauthDropbox(): Promise<CloudHandler> {
        return this.#oauthPkceFlow({
            service: "dropbox",
            clientId: this.#clientIds.Dropbox,
            authUrlBase: "https://www.dropbox.com/oauth2/authorize",
            tokenUrl: "https://api.dropboxapi.com/oauth2/token",
            scope: "", // Dropbox scope is optional
            extraAuthParams: {
                token_access_type: "offline"
            }
        })
    }

    async #oauthGoogle(): Promise<CloudHandler> {
        const clientId = this.#clientIds.GoogleDrive
        const scope = "https://www.googleapis.com/auth/drive.appdata"
        const redirectUri = `${location.origin}/auth-callback.html`
        const params = new URLSearchParams({
            client_id: clientId,
            response_type: "token",
            redirect_uri: redirectUri,
            scope,
            include_granted_scopes: "true",
            prompt: "consent"
        })
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
        console.debug("[CloudAuth] Opening auth window:", authUrl)
        const authWindow = window.open(authUrl, "cloudAuth")
        if (isNull(authWindow)) {
            return Errors.warn("Failed to open authentication window. Please check popup blockers.")
        }
        const {resolve, reject, promise} = Promise.withResolvers<CloudHandler>()
        const channel = new BroadcastChannel("auth-callback")
        const dialog = RuntimeNotifier.progress({
            headline: "Google Drive",
            message: "Please authorize access to app data...",
            cancel: () => reject("cancelled")
        })
        channel.onmessage = async (event: MessageEvent<any>) => {
            const data = asDefined(event.data, "No data")
            console.debug("[CloudAuth] Received via BroadcastChannel:", data)
            if (data.type === "auth-callback" && isDefined(data.access_token)) {
                try {
                    const accessToken = data.access_token
                    resolve(await this.#createHandler("google", accessToken))
                } catch (err) {
                    reject(err)
                }
            } else if (data.type === "closed") {
                console.debug("[CloudAuth] Callback window closed")
                reject(null)
            }
        }
        return promise.finally(() => {
            console.debug("[CloudAuth] Closing auth window")
            authWindow.close()
            dialog.terminate()
            channel.close()
        })
    }

    async #createHandler(service: string, token: string): Promise<CloudHandler> {
        switch (service) {
            case "dropbox": {
                return new DropboxHandler(token)
            }
            case "google": {
                return new GoogleDriveHandler(token)
            }
            default:
                return panic(`Handler not implemented for service: ${service}`)
        }
    }
}