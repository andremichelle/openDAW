const username = "openDAW"
const password = "prototype"
export const base64Credentials = btoa(`${username}:${password}`)
export const OpenDAWHeaders: RequestInit = {
    method: "GET",
    headers: {"Authorization": `Basic ${base64Credentials}`}
}