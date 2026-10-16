import { REGIONS } from "./regions.mjs"

const TOKEN_URIS = new Set([
  "https://oauth2.googleapis.com/token",
  "https://accounts.google.com/o/oauth2/token",
  "https://www.googleapis.com/oauth2/v4/token",
])

export function tokenUri(creds) {
  const uri = creds.token_uri ?? "https://oauth2.googleapis.com/token"
  if (!TOKEN_URIS.has(uri)) throw new Error("token_uri must be an allowed HTTPS Google OAuth token endpoint")
  return uri
}

// Check the final URL as well as its components. Redirects must never carry
// credentials or request bodies to another endpoint.
export function googleFetch(fetch) {
  const hosts = new Set(["texttospeech.googleapis.com", ...REGIONS.map(r => r === "global" ? "aiplatform.googleapis.com" : `${r}-aiplatform.googleapis.com`)])
  return (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.href ?? input.url)
    if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.port || url.username || url.password) {
      throw new Error("Refusing a request outside the allowed Google API endpoints")
    }
    return fetch(input, { ...init, redirect: "error" })
  }
}
