import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { authorizeAdc, clearTokenCache } from "../lib/auth.mjs"
import { discoveredFile, lookup, mergeDiscovered } from "../lib/catalog.mjs"
import { BASE, locationBase } from "../lib/regions.mjs"
import { route } from "../lib/route.mjs"
import { _internal } from "../index.mjs"

const response = (value, status = 200, headers = {}) => Response.json(value, { status, headers })
const prompt = { contents: [{ role: "user", parts: [{ text: "test prompt" }] }] }
const ctxFor = (fetch, mediaDir) => ({ project: "demo", location: "auto", options: {}, token: async () => "fake-token", fetch, log: () => {}, mediaDir })

describe("review regressions", () => {
  test("failed discovery backs off, retries later, and can refresh again after success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vertex-discovery-retry-"))
    const originalNow = Date.now
    let now = originalNow(), calls = 0
    Date.now = () => now
    const ctx = { project: "demo" }
    const run = async () => { if (++calls === 1) throw new Error("test failure") }
    try {
      await _internal.discoverOnce(ctx, dir, () => {}, run)
      await _internal.discoverOnce(ctx, dir, () => {}, run)
      expect(calls).toBe(1)
      now += 60_001
      await _internal.discoverOnce(ctx, dir, () => {}, run)
      expect(calls).toBe(2)
      await _internal.discoverOnce(ctx, dir, () => {}, run)
      expect(calls).toBe(3)
    } finally { Date.now = originalNow; await rm(dir, { recursive: true, force: true }) }
  })

  test.each(["gemini-2.5-flash-tts", "chirp3-hd", "lyria-002", "veo-3.1-generate-001"])("%s propagates cancellation instead of returning a retryable error", async model => {
    const abort = new DOMException("test cancellation", "AbortError")
    const ctx = ctxFor(async () => { throw abort })
    await expect(route(BASE + `/models/${model}:generateContent`, { body: JSON.stringify(prompt) }, ctx)).rejects.toBe(abort)
  })

  test.each([
    ["/chat/completions", { model: "deepseek-v3.2-maas", messages: [] }],
    ["/messages", { model: "claude-haiku-4-5", messages: [] }],
    ["/models/gemini-2.5-flash:streamGenerateContent?alt=sse", prompt],
    ["/embeddings", { model: "text-embedding-005", input: "test" }],
    ["/models/gemini-2.5-flash-tts:generateContent", prompt],
    ["/models/chirp3-hd:generateContent", prompt],
    ["/models/lyria-002:generateContent", prompt],
    ["/models/veo-3.1-generate-001:generateContent", prompt],
  ])("%s preserves upstream retry headers through the real handler", async (path, body) => {
    const ctx = ctxFor(async () => response({ error: { message: "quota" } }, 429, { "retry-after": "17", "x-request-id": "review-test" }))
    const res = await route(BASE + path, { body: JSON.stringify(body) }, ctx)
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("17")
    expect(res.headers.get("x-request-id")).toBe("review-test")
  })

  test("non-streaming Gemini uses generateContent and returns JSON", async () => {
    const calls = []
    const reply = { candidates: [{ content: { role: "model", parts: [{ text: "test reply" }] } }] }
    const ctx = ctxFor(async url => { calls.push(url); return response(reply) })
    const res = await route(BASE + "/models/gemini-2.5-flash:generateContent", { body: JSON.stringify(prompt) }, ctx)
    expect(calls[0]).toEndWith(":generateContent")
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual(reply)
  })

  test.each(["chirp3-hd", "gemini-2.5-flash-tts", "lyria-002", "veo-3.1-generate-001"])("non-streaming %s returns a Gemini JSON response", async model => {
    const dir = await mkdtemp(join(tmpdir(), "vertex-nonstream-"))
    try {
      const fetch = async url => {
        if (url.endsWith(":predictLongRunning")) return response({ name: "test-operation" })
        if (url.endsWith(":fetchPredictOperation")) return response({ done: true, response: { videos: [{ bytesBase64Encoded: "dGVzdA==", mimeType: "video/mp4" }] } })
        if (url.endsWith(":predict")) return response({ predictions: [{ audioContent: "dGVzdA==", mimeType: "audio/wav" }] })
        if (url.includes("texttospeech")) return response({ audioContent: "dGVzdA==" })
        return response({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "dGVzdA==" } }] } }] })
      }
      const ctx = ctxFor(fetch, dir)
      ctx.options.veoPollMs = 0
      const res = await route(BASE + `/models/${model}:generateContent`, { body: JSON.stringify(prompt), signal: null }, ctx)
      expect(res.headers.get("content-type")).toContain("application/json")
      const reply = await res.json()
      expect(reply.candidates[0].finishReason).toBe("STOP")
      if (!model.startsWith("veo-")) expect(reply.candidates[0].content.parts.some(p => p.inlineData)).toBe(true)
      expect(reply.candidates[0].content.parts.some(p => p.text?.includes("Path:"))).toBe(true)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("timestamp fallback respects the account catalog and refuses before sending audio", async () => {
    const entries = [lookup("gemini-3.5-transcribe-preview").entry]
    const form = new FormData()
    form.set("model", entries[0].id)
    form.set("file", new File(["fake audio"], "test.wav", { type: "audio/wav" }))
    form.set("response_format", "srt")
    const built = new Response(form)
    let calls = 0
    const res = await route(BASE + "/audio/transcriptions", {
      headers: { "content-type": built.headers.get("content-type") }, body: await built.arrayBuffer(),
    }, ctxFor(async () => { calls++; return response({}) }), { entries })
    expect(res.status).toBe(400)
    expect(calls).toBe(0)
  })

  test("timestamp fallback uses the fallback model's account-specific regions", async () => {
    const entries = [lookup("gemini-3.5-transcribe-preview").entry, { ...lookup("gemini-2.5-flash").entry, regions: ["europe-west4"] }]
    const form = new FormData()
    form.set("model", entries[0].id)
    form.set("file", new File(["fake audio"], "test.wav", { type: "audio/wav" }))
    form.set("response_format", "srt")
    const built = new Response(form), calls = []
    const res = await route(BASE + "/audio/transcriptions", {
      headers: { "content-type": built.headers.get("content-type") }, body: await built.arrayBuffer(),
    }, ctxFor(async url => { calls.push(url); return response({ candidates: [{ content: { parts: [{ text: '{"segments":[]}' }] } }] }) }), { entries })
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain("/locations/europe-west4/")
  })

  test("legacy domain-scoped projects are safe in both URLs and Windows cache filenames", () => {
    const project = "example.com:my-project"
    const url = new URL(locationBase(project, "global"))
    expect(url.hostname).toBe("aiplatform.googleapis.com")
    expect(decodeURIComponent(url.pathname)).toContain(`/projects/${project}/`)
    expect(basename(discoveredFile("config", project))).not.toContain(":")
  })

  test("known catalog IDs cannot claim a different family in the cache", () => {
    expect(() => mergeDiscovered({ models: [{ id: "gemini-2.5-flash", publisher: "google", family: "embedding", regions: ["global"] }] })).toThrow("family")
  })

  test("ADC uses gcloud's configured credential directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vertex-adc-path-"))
    const originalFetch = globalThis.fetch
    const keys = ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG", "APPDATA"]
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
    try {
      clearTokenCache()
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS
      process.env.CLOUDSDK_CONFIG = dir
      await writeFile(join(dir, "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "fake-id", client_secret: "fake-secret", refresh_token: "fake-refresh" }))
      globalThis.fetch = async () => response({ access_token: "fake-access", expires_in: 3600 })
      expect((await authorizeAdc({ project: "demo" }).callback()).type).toBe("success")
      if (process.platform === "win32") {
        delete process.env.CLOUDSDK_CONFIG
        process.env.APPDATA = dir
        await mkdir(join(dir, "gcloud"))
        await writeFile(join(dir, "gcloud", "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "fake-id", client_secret: "fake-secret", refresh_token: "fake-refresh" }))
        expect((await authorizeAdc({ project: "demo" }).callback()).type).toBe("success")
      }
    } finally {
      globalThis.fetch = originalFetch
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
      await rm(dir, { recursive: true, force: true })
    }
  })
})
