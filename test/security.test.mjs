import { beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as plugin from "../index.mjs"
import { accessToken, clearTokenCache, credentialKey, identity, parseCredentials } from "../lib/auth.mjs"
import { discoveredFile, loadDiscovered, lookup, mergeDiscovered, toModel } from "../lib/catalog.mjs"
import { regionsFor } from "../lib/failover.mjs"
import { BASE, locationBase, modelUrl } from "../lib/regions.mjs"
import { googleFetch } from "../lib/security.mjs"
import { route } from "../lib/route.mjs"
import { handle as transcribe } from "../lib/handlers/transcribe.mjs"

const user = (refresh_token = "test-refresh") => ({ type: "authorized_user", client_id: "test-client", client_secret: "test-secret", refresh_token })
const model = { id: "deepseek-v3.2-maas", publisher: "deepseek-ai", family: "maas", regions: ["global"] }
beforeEach(clearTokenCache)

describe("credential and request destinations", () => {
  test.each([
    "https://collector.invalid/token", "http://oauth2.googleapis.com/token",
    "https://oauth2.googleapis.com.collector.invalid/token", "https://user@oauth2.googleapis.com/token",
    "https://oauth2.googleapis.com:444/token", "https://oauth2.googleapis.com/token?next=evil",
    "https://oauth2.googleapis.com/token#fragment", "",
  ])("rejects token_uri %s before minting, even with a cached token", async uri => {
    const creds = user()
    let calls = 0
    const fetch = async () => { calls++; return Response.json({ access_token: "test-token", expires_in: 3600 }) }
    await accessToken(creds, { fetch })
    expect(() => parseCredentials(JSON.stringify({ ...creds, token_uri: uri }))).toThrow("token_uri")
    expect(() => accessToken({ ...creds, token_uri: uri }, { fetch })).toThrow("token_uri")
    expect(calls).toBe(1)
  })

  test("token exchanges and model calls disable redirects", async () => {
    const calls = []
    const fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ access_token: "test-token", expires_in: 3600 }) }
    await accessToken(user(), { fetch })
    await googleFetch(fetch)(modelUrl("demo", "global", "google", "gemini-2.5-flash", "generateContent"), { redirect: "follow" })
    expect(calls.map(c => c.init.redirect)).toEqual(["error", "error"])
  })

  test.each([
    "https://collector.invalid/v1", "http://aiplatform.googleapis.com/v1",
    "https://aiplatform.googleapis.com:444/v1", "https://user@aiplatform.googleapis.com/v1",
    "https://aiplatform.googleapis.com.collector.invalid/v1",
  ])("blocks final URL %s without calling fetch", url => {
    let calls = 0
    expect(() => googleFetch(() => { calls++ })(url, { body: "private prompt" })).toThrow("Refusing")
    expect(calls).toBe(0)
  })

  test("separates tokens and ADC identities with matching refresh-token suffixes", async () => {
    const a = user("alice-1234567890123456"), b = user("bob-1234567890123456")
    let calls = 0
    const fetch = async () => Response.json({ access_token: `token-${++calls}`, expires_in: 3600 })
    expect(await accessToken(a, { fetch })).toBe("token-1")
    expect(await accessToken(b, { fetch })).toBe("token-2")
    expect(identity(a)).not.toBe(identity(b))
    expect(credentialKey(a)).not.toBe(credentialKey(b))
    expect(credentialKey(a)).not.toContain(a.refresh_token)
  })
})

describe("catalog trust boundary", () => {
  test.each(["collector.invalid/", "global/../../evil", "us-central1@evil", "global?evil", "\\evil", "unknown-region"])("rejects region %s at cache and URL boundaries", region => {
    expect(() => mergeDiscovered({ models: [{ ...model, regions: [region] }] })).toThrow("region")
    expect(() => regionsFor({ regions: [region] }, {})).toThrow("region")
    expect(() => locationBase("demo", region)).toThrow("region")
  })

  test.each(["../outside", "x/../../outside", "demo?evil", "demo#evil", "demo\\evil"])("rejects project %s before path or URL construction", project => {
    expect(() => discoveredFile("config", project)).toThrow("project")
    expect(() => locationBase(project, "global")).toThrow("project")
  })

  test("rejects malformed resource paths and schema, and ignores inherited family names", () => {
    expect(() => mergeDiscovered({ models: {} })).toThrow("array")
    expect(() => mergeDiscovered({ models: [{ ...model, id: "../evil" }] })).toThrow("segment")
    expect(() => mergeDiscovered({ models: [{ ...model, regions: [] }] })).toThrow("regions")
    expect(mergeDiscovered({ models: [{ ...model, family: "constructor" }] })).toEqual([])
  })

  test("separates account catalogs and rejects mismatched or polluted files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vertex-security-"))
    try {
      await mkdir(join(dir, "vertex-ai"))
      const a = credentialKey(user("a")), b = credentialKey(user("b"))
      const data = { project: "demo", accountScope: a, models: [model] }
      await writeFile(discoveredFile(dir, "demo", a), JSON.stringify(data))
      expect(await loadDiscovered(dir, "demo", a)).toEqual(data)
      expect(await loadDiscovered(dir, "demo", b)).toBeNull()
      await writeFile(discoveredFile(dir, "demo", b), JSON.stringify(data))
      expect(await loadDiscovered(dir, "demo", b)).toBeNull()
      await writeFile(discoveredFile(dir, "demo", a), JSON.stringify({ ...data, project: "other" }))
      expect(await loadDiscovered(dir, "demo", a)).toBeNull()
      await writeFile(discoveredFile(dir, "demo", a), JSON.stringify({ ...data, models: [{ ...model, regions: ["collector.invalid/"] }] }))
      expect(await loadDiscovered(dir, "demo", a)).toBeNull()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe("Magpie hook and model contract", () => {
  test("entry exports exactly one plugin function", () => {
    expect(Object.values(plugin).filter(v => typeof v === "function")).toEqual([plugin.VertexAIPlugin])
  })

  test("preserves user provider configuration", async () => {
    const hooks = await plugin.VertexAIPlugin({ directory: ".", client: {} })
    const provider = { name: "Custom", models: {} }, cfg = { provider: { "vertex-ai": provider } }
    await hooks.config(cfg)
    expect(cfg.provider["vertex-ai"]).toBe(provider)
  })

  test.each(["gemini-2.5-flash", "deepseek-v3.2-maas", "claude-haiku-4-5"])("the host API id for %s retains its pinned region through routing", async key => {
    const entry = lookup(key).entry
    const model = toModel(entry, "global")
    const calls = []
    const ctx = { project: "demo", token: async () => "test-token", fetch: async (url) => { calls.push(url); return new Response("quota", { status: 429 }) }, log: () => {} }
    const path = entry.family === "claude" ? "/messages" : entry.family === "maas" ? "/chat/completions" : `/models/${model.api.id}:streamGenerateContent?alt=sse`
    const res = await route(BASE + path, { body: JSON.stringify({ model: model.api.id, stream: true }) }, ctx)
    expect(res.status).toBe(429)
    expect(calls.length).toBe(1)
    expect(new URL(calls[0]).pathname).toContain("/locations/global/")
  })

  test("loader honors options.location for auto login and keeps catalogs account-scoped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vertex-hooks-"))
    const original = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ choices: [] }) }
    try {
      const hooks = await plugin.VertexAIPlugin({ directory: dir }, { autoDiscover: false, location: "us-east5" })
      const a = user("a"), b = user("b")
      const auth = creds => ({ type: "oauth", project: "demo", location: "auto", refresh: JSON.stringify(creds), access: "test-token", expires: Date.now() + 3600000 })
      await mkdir(join(dir, "vertex-ai"))
      await writeFile(discoveredFile(dir, "demo", credentialKey(a)), JSON.stringify({ project: "demo", accountScope: credentialKey(a), models: [model] }))
      const modelsA = await hooks.provider.models({ models: {} }, { auth: auth(a) })
      const modelsB = await hooks.provider.models({ models: {} }, { auth: auth(b) })
      expect(Object.keys(modelsA)).toEqual(["deepseek-v3.2-maas"])
      expect(modelsB["gemini-2.5-flash"]).toBeDefined()
      const loader = await hooks.auth.loader(async () => auth(b))
      await loader.fetch(BASE + "/chat/completions", { body: JSON.stringify({ model: "gemini-2.5-flash", messages: [] }) })
      expect(calls.length).toBe(1)
      expect(calls[0].url).toContain("/locations/us-east5/")
      expect(calls[0].init.redirect).toBe("error")
    } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }) }
  })
})

test("timestamp transcription keeps a pin, or refuses an unavailable pinned region before sending audio", async () => {
  const form = new FormData()
  form.set("file", new File(["fake audio"], "test.wav", { type: "audio/wav" }))
  form.set("response_format", "srt")
  const entry = lookup("gemini-3.5-transcribe-preview").entry
  const req = { form, entry, suffix: "/audio/transcriptions", pinned: "us-east5" }
  const calls = []
  const ctx = { project: "demo", token: async () => "test-token", fetch: async url => { calls.push(url); return Response.json({ candidates: [{ content: { parts: [{ text: '{"segments":[]}' }] } }] }) } }
  expect((await transcribe(req, ctx)).status).toBe(200)
  expect(calls[0]).toContain("/locations/us-east5/")
  req.pinned = "asia-east1"
  expect((await transcribe(req, ctx)).status).toBe(400)
  expect(calls.length).toBe(1)
})
