import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { WebSocketServer } from "ws"
import { simMiddleware } from "./.repos/serve-sim/packages/serve-sim/dist/middleware.js"
import { LiveTouchController, RawDTUHIDTransport } from "./src/dtuhid.mjs"

const execFileAsync = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))
const PANE_BASE = "/panes/simulator"
const UDID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i
const DATA_DIR = process.env.CODEVISOR_PLUGIN_DATA_DIR || join(tmpdir(), "codevisor-ios-simulator-dev")
const PREFERENCES_PATH = join(DATA_DIR, "pane-preferences.json")
const DTUHID_BROKER_PATH = join(ROOT, "bin", "codevisor-dtuhid-broker")
const STATIC_FILES = new Map([
  [`${PANE_BASE}/`, ["src/index.html", "text/html; charset=utf-8"]],
  [`${PANE_BASE}/app.js`, ["src/app.js", "text/javascript; charset=utf-8"]],
  [`${PANE_BASE}/styles.css`, ["src/styles.css", "text/css; charset=utf-8"]],
  ["/assets/icon.svg", ["assets/icon.svg", "image/svg+xml"]],
])

const simulatorMiddleware = simMiddleware({
  basePath: PANE_BASE,
  proxyHelpers: true,
  codec: "mjpeg",
})

let preferenceCache
let preferenceWrite = Promise.resolve()
export function inputTransportForRuntime(runtime) {
  const match = /^iOS\s+(\d+)/.exec(runtime || "")
  return match && Number(match[1]) >= 27 ? "dtuhid" : "legacy-hid"
}

const dtuhidTransport = new RawDTUHIDTransport({ executable: DTUHID_BROKER_PATH })
const liveTouchController = new LiveTouchController({
  transport: dtuhidTransport,
})
const liveTouchWebSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
})

export function decodeContext(header) {
  try {
    return JSON.parse(Buffer.from(header || "", "base64").toString("utf8"))
  } catch {
    return {}
  }
}

export function hasCodevisorPaneContext(request) {
  const context = decodeContext(request.headers["x-codevisor-context"])
  return Boolean(context.paneId || context.workspaceId || context.pluginId)
}

export function panePreferenceKey(context) {
  if (context.paneId) return `pane:${context.paneId}`
  if (context.workspaceId) return `workspace:${context.workspaceId}`
  if (context.cwd) return `cwd:${context.cwd}`
  return "global"
}

export function runtimeLabel(identifier) {
  const raw = identifier.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "")
  const separator = raw.indexOf("-")
  if (separator === -1) return raw
  return `${raw.slice(0, separator)} ${raw.slice(separator + 1).replaceAll("-", ".")}`
}

export function parseDeviceList(payload) {
  const devices = []
  for (const [runtimeId, entries] of Object.entries(payload?.devices || {})) {
    for (const device of entries || []) {
      if (!device?.isAvailable || !UDID_PATTERN.test(device.udid || "")) continue
      devices.push({
        udid: device.udid,
        name: device.name || "iOS Simulator",
        state: device.state || "Shutdown",
        runtime: runtimeLabel(runtimeId),
        deviceType: String(device.deviceTypeIdentifier || "").split(".").at(-1) || "iPhone",
        lastBootedAt: device.lastBootedAt || null,
      })
    }
  }
  return devices.sort((a, b) => {
    const stateOrder = Number(b.state === "Booted") - Number(a.state === "Booted")
    if (stateOrder) return stateOrder
    const recency = String(b.lastBootedAt || "").localeCompare(String(a.lastBootedAt || ""))
    if (recency) return recency
    const runtime = b.runtime.localeCompare(a.runtime, undefined, { numeric: true })
    return runtime || a.name.localeCompare(b.name, undefined, { numeric: true })
  })
}

async function loadPreferences() {
  if (preferenceCache) return preferenceCache
  try {
    preferenceCache = JSON.parse(await readFile(PREFERENCES_PATH, "utf8"))
  } catch {
    preferenceCache = { selectedDevices: {} }
  }
  preferenceCache.selectedDevices ||= {}
  return preferenceCache
}

async function saveSelection(key, udid) {
  const preferences = await loadPreferences()
  preferences.selectedDevices[key] = udid
  preferenceWrite = preferenceWrite.then(async () => {
    await mkdir(DATA_DIR, { recursive: true })
    const temporaryPath = `${PREFERENCES_PATH}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`)
    await rename(temporaryPath, PREFERENCES_PATH)
  })
  await preferenceWrite
}

async function runSimctl(args, timeout = 15_000) {
  try {
    return await execFileAsync("xcrun", ["simctl", ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout,
    })
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim()
    throw new Error(detail || `simctl ${args[0]} failed`)
  }
}

async function captureScreenshot(udid) {
  return new Promise((resolve, reject) => {
    execFile(
      "xcrun",
      ["simctl", "io", udid, "screenshot", "--type=png", "-"],
      { encoding: "buffer", maxBuffer: 25 * 1024 * 1024, timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || error).trim()))
          return
        }
        resolve(Buffer.from(stdout))
      },
    )
  })
}

async function listDevices() {
  const { stdout } = await runSimctl(["list", "devices", "available", "-j"])
  return parseDeviceList(JSON.parse(stdout))
}

async function selectedState(request) {
  const context = decodeContext(request.headers["x-codevisor-context"])
  const key = panePreferenceKey(context)
  const preferences = await loadPreferences()
  const devices = await listDevices()
  const preferred = devices.find((device) => device.udid === preferences.selectedDevices[key])
  const selected = preferred || devices.find((device) => device.state === "Booted") || devices[0] || null
  return {
    devices,
    selected: selected ? { ...selected, inputTransport: inputTransportForRuntime(selected.runtime) } : null,
    context: {
      paneId: context.paneId || null,
      workspaceId: context.workspaceId || null,
      cwd: context.cwd || null,
    },
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  response.end(JSON.stringify(value))
}

function sendError(response, error, status = 500) {
  sendJson(response, status, { error: error instanceof Error ? error.message : String(error) })
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error("Request body is too large")
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new Error("Request body must be valid JSON")
  }
}

function requireUdid(value) {
  if (!UDID_PATTERN.test(value || "")) throw new Error("Invalid simulator UDID")
  return value
}

async function serveStatic(response, file, contentType) {
  const body = await readFile(join(ROOT, file))
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": file.endsWith("index.html") ? "no-store" : "no-cache",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  })
  response.end(body)
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1")

  if (url.pathname === "/health") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
    response.end("ok")
    return
  }

  if (url.pathname.startsWith(`${PANE_BASE}/helper/`)) {
    await simulatorMiddleware(request, response, async () => {
      if (!response.headersSent) response.writeHead(404)
      response.end("Not found")
    })
    return
  }

  if (url.pathname === `${PANE_BASE}/api/event-log` && request.method === "GET") {
    await simulatorMiddleware(request, response, async () => {
      if (!response.headersSent) response.writeHead(404)
      response.end("Not found")
    })
    return
  }

  const staticFile = STATIC_FILES.get(url.pathname)
  if (staticFile && request.method === "GET") {
    await serveStatic(response, ...staticFile)
    return
  }

  if (url.pathname === `${PANE_BASE}/api/state` && request.method === "GET") {
    sendJson(response, 200, await selectedState(request))
    return
  }

  if (url.pathname === `${PANE_BASE}/api/device/select` && request.method === "POST") {
    const body = await readJson(request)
    const udid = requireUdid(body.udid)
    const devices = await listDevices()
    const device = devices.find((candidate) => candidate.udid === udid)
    if (!device) throw new Error("Simulator is not available")
    const context = decodeContext(request.headers["x-codevisor-context"])
    await saveSelection(panePreferenceKey(context), udid)
    if (device.state !== "Booted" && body.boot !== false) {
      await runSimctl(["boot", udid], 30_000)
    }
    sendJson(response, 200, await selectedState(request))
    return
  }

  if (url.pathname === `${PANE_BASE}/api/device/shutdown` && request.method === "POST") {
    const body = await readJson(request)
    const udid = requireUdid(body.udid)
    await runSimctl(["shutdown", udid], 30_000)
    sendJson(response, 200, await selectedState(request))
    return
  }

  if (url.pathname === `${PANE_BASE}/api/screenshot` && request.method === "GET") {
    const udid = requireUdid(url.searchParams.get("udid"))
    const image = await captureScreenshot(udid)
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="ios-simulator-${udid.slice(0, 8)}.png"`,
      "Cache-Control": "no-store",
      "Content-Length": image.length,
    })
    response.end(image)
    return
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
  response.end("Not found")
}

export function createPluginServer() {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error("[ios-simulator] request failed:", error)
      if (!response.headersSent) sendError(response, error)
      else response.destroy(error instanceof Error ? error : undefined)
    })
  })

  server.keepAliveTimeout = 0
  server.headersTimeout = 0
  server.requestTimeout = 0
  server.timeout = 0
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname
    const liveTouchMatch = new RegExp(`^${PANE_BASE}/input/(${UDID_PATTERN.source.slice(1, -1)})/ws$`, "i").exec(pathname)
    if (liveTouchMatch) {
      // Codevisor terminates the public WebSocket and proxies it to this loopback
      // server. The browser Origin therefore names Codevisor's port while Host names
      // this private plugin port, so a direct Origin/Host comparison rejects every
      // legitimate webview. Trust the context header Codevisor injects instead.
      if (!hasCodevisorPaneContext(request)) {
        socket.destroy()
        return
      }
      const udid = liveTouchMatch[1]
      liveTouchWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        liveTouchController.attach(webSocket, udid)
      })
      return
    }
    if (pathname.startsWith(`${PANE_BASE}/helper/`)) {
      simulatorMiddleware.handleUpgrade(request, socket, head)
      return
    }
    socket.destroy()
  })
  server.on("close", () => void liveTouchController.close())
  return server
}

async function main() {
  const port = Number(process.env.PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port")
  }
  const server = createPluginServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  console.log(`[ios-simulator] listening on http://127.0.0.1:${port}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[ios-simulator] failed to start:", error)
    process.exitCode = 1
  })
}
