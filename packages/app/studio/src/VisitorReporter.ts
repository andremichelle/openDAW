const API_URL = "https://api.opendaw.studio/users/count.php"

// No payload: the server derives a daily anonymous id from the request itself (HMAC with a
// secret discarded at end of day). Nothing is stored on or read from the visitor's device.
export const reportVisitor = (): void => {
    navigator.sendBeacon(API_URL)
}
