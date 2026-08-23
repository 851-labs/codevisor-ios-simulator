import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BROKER_PROTOCOL_VERSION = 1
const BROKER_START_TIMEOUT_MS = 30_000
const BROKER_REQUEST_TIMEOUT_MS = 5_000
const KEEPALIVE_INTERVAL_MS = 25_000
const MAX_MESSAGE_BYTES = 64 * 1024
const EDGE_MOVE_SAMPLES_TO_PRESERVE = 5
const ORIENTATIONS = new Set([
  "portrait",
  "portrait_upside_down",
  "landscape_left",
  "landscape_right",
])

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function socketSend(socket, value) {
  if (socket.readyState !== 1) return
  socket.send(JSON.stringify(value))
}

function inputError(message, cause, safeToRetry = false) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = cause?.code
  error.safeToRetry = safeToRetry
  return error
}

export function fnv1a64(value) {
  let hash = 14_695_981_039_346_656_037n
  for (const byte of Buffer.from(value, "utf8")) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1_099_511_628_211n)
  }
  return hash.toString(16)
}

export function brokerEndpointPath({ simulatorUdid, developerDirectory, temporaryDirectory }) {
  // macOS sockaddr_un.sun_path is only 104 bytes. DARWIN_USER_TEMP_DIR is
  // already long, so keep this private per-user namespace deliberately short.
  const root = join(temporaryDirectory, `cvhid-${process.getuid()}`)
  const simulatorIdentity = fnv1a64(simulatorUdid)
  const developerIdentity = fnv1a64(developerDirectory)
  return join(root, `${simulatorIdentity}-${developerIdentity}-v${BROKER_PROTOCOL_VERSION}.sock`)
}

export function parseLiveTouch(value) {
  const message = typeof value === "string" ? JSON.parse(value) : value
  if (!message || !["begin", "move", "end"].includes(message.type)) {
    throw new Error("Touch type must be begin, move, or end")
  }
  const x = Number(message.x)
  const y = Number(message.y)
  if (!Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0 || y > 1) {
    throw new Error("Touch coordinates must be between 0 and 1")
  }
  const orientation = ORIENTATIONS.has(message.orientation) ? message.orientation : "portrait"
  const touch = { type: message.type, x, y, orientation }
  if (message.edge !== undefined) {
    const edge = Number(message.edge)
    if (!Number.isInteger(edge) || edge < 0 || edge > 4) {
      throw new Error("Touch edge must be an integer between 0 and 4")
    }
    touch.edge = edge
  }
  return touch
}

export function rawPointForTouch(touch) {
  switch (touch.orientation) {
    case "portrait_upside_down":
      return { x: 1 - touch.x, y: 1 - touch.y }
    case "landscape_left":
      return { x: touch.y, y: 1 - touch.x }
    case "landscape_right":
      return { x: 1 - touch.y, y: touch.x }
    default:
      return { x: touch.x, y: touch.y }
  }
}

export function rawEdgeForTouch(edge, orientation) {
  if (!Number.isInteger(edge) || edge < 1 || edge > 4) return 0
  switch (orientation) {
    case "landscape_left":
      return { 1: 3, 2: 1, 3: 4, 4: 2 }[edge]
    case "landscape_right":
      return { 1: 2, 2: 4, 3: 1, 4: 3 }[edge]
    case "portrait_upside_down":
      return { 1: 4, 2: 3, 3: 2, 4: 1 }[edge]
    default:
      return edge
  }
}

async function readLineExchange(endpoint, request, timeoutMilliseconds = BROKER_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: endpoint })
    let buffer = Buffer.alloc(0)
    let stage = "handshake"
    let requestWritten = false
    let settled = false

    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(inputError(error.message || String(error), error, !requestWritten))
      else resolve()
    }

    socket.setTimeout(timeoutMilliseconds, () => finish(new Error(`DTUHID broker ${stage} timed out`)))
    socket.on("error", finish)
    socket.on("close", () => {
      if (!settled) finish(new Error(`DTUHID broker closed during ${stage}`))
    })
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_MESSAGE_BYTES) {
        finish(new Error("DTUHID broker response is too large"))
        return
      }
      let newline
      while (!settled && (newline = buffer.indexOf(0x0a)) !== -1) {
        const line = buffer.subarray(0, newline).toString("utf8")
        buffer = buffer.subarray(newline + 1)
        let response
        try {
          response = JSON.parse(line)
        } catch (error) {
          finish(new Error(`DTUHID broker returned invalid JSON: ${error.message}`))
          return
        }
        if (stage === "handshake") {
          if (response.ready !== true) {
            finish(new Error("DTUHID broker is not ready"))
            return
          }
          stage = "response"
          const payload = `${JSON.stringify(request)}\n`
          if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) {
            finish(new Error("DTUHID broker request is too large"))
            return
          }
          requestWritten = true
          socket.write(payload)
          continue
        }
        if (response.error) {
          finish(new Error(String(response.error)))
          return
        }
        finish()
      }
    })
  })
}

export class RawDTUHIDTransport {
  constructor({ executable, developerDirectory, temporaryDirectory = tmpdir() }) {
    this.executable = executable
    this.developerDirectoryOverride = developerDirectory
    this.temporaryDirectory = temporaryDirectory
    this.endpointPromises = new Map()
    this.readyPromises = new Map()
  }

  async endpointFor(simulatorUdid) {
    if (!this.endpointPromises.has(simulatorUdid)) {
      this.endpointPromises.set(simulatorUdid, (async () => {
        const developerDirectory = await realpath(
          this.developerDirectoryOverride || process.env.DEVELOPER_DIR || (await this.xcodeDeveloperDirectory()),
        )
        const endpoint = brokerEndpointPath({
          simulatorUdid,
          developerDirectory,
          temporaryDirectory: join(this.temporaryDirectory),
        })
        if (Buffer.byteLength(endpoint) >= 104) {
          throw new Error("The DTUHID broker socket path exceeds macOS's 104-byte limit")
        }
        await this.ensurePrivateDirectory(endpoint)
        return endpoint
      })())
    }
    return this.endpointPromises.get(simulatorUdid)
  }

  async xcodeDeveloperDirectory() {
    const { execFile } = await import("node:child_process")
    return new Promise((resolve, reject) => {
      execFile("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout.trim())
      })
    })
  }

  async ensurePrivateDirectory(endpoint) {
    const root = join(endpoint, "..")
    await mkdir(root, { recursive: true, mode: 0o700 })
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) {
      throw new Error("The DTUHID broker directory is not a private owned directory")
    }
    if ((info.mode & 0o077) !== 0) await chmod(root, 0o700)
  }

  async removeStaleEndpoint(endpoint) {
    try {
      const info = await lstat(endpoint)
      if (!info.isSocket() || info.uid !== process.getuid()) return
      await unlink(endpoint)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }

  async spawnBroker(simulatorUdid, endpoint) {
    await new Promise((resolve, reject) => {
      const child = spawn(this.executable, ["--udid", simulatorUdid, "--socket", endpoint], {
        detached: true,
        stdio: "ignore",
      })
      child.once("error", reject)
      child.once("spawn", () => {
        child.unref()
        resolve()
      })
    })
  }

  async warm(simulatorUdid) {
    if (this.readyPromises.has(simulatorUdid)) return this.readyPromises.get(simulatorUdid)
    const ready = (async () => {
      const endpoint = await this.endpointFor(simulatorUdid)
      try {
        await readLineExchange(endpoint, { ping: true })
        return
      } catch (error) {
        if (error.code === "ECONNREFUSED") await this.removeStaleEndpoint(endpoint)
        else if (error.code !== "ENOENT") throw error
      }

      await this.spawnBroker(simulatorUdid, endpoint)
      const deadline = Date.now() + BROKER_START_TIMEOUT_MS
      let lastError
      while (Date.now() < deadline) {
        try {
          await readLineExchange(endpoint, { ping: true }, 2_000)
          return
        } catch (error) {
          lastError = error
          await delay(100)
        }
      }
      throw new Error(`DTUHID broker did not become ready: ${lastError?.message || "startup timed out"}`)
    })()
    this.readyPromises.set(simulatorUdid, ready)
    try {
      await ready
    } finally {
      this.readyPromises.delete(simulatorUdid)
    }
  }

  async sendTouch(simulatorUdid, touch, gesture) {
    const point = rawPointForTouch(touch)
    const request = {
      gesture,
      touch: {
        type: touch.type,
        x: point.x,
        y: point.y,
        edge: rawEdgeForTouch(touch.edge || 0, touch.orientation),
      },
    }
    const endpoint = await this.endpointFor(simulatorUdid)
    try {
      await readLineExchange(endpoint, request)
    } catch (error) {
      if (!error.safeToRetry) throw error
      await this.warm(simulatorUdid)
      await readLineExchange(endpoint, request)
    }
  }
}

export class LiveTouchController {
  constructor({ transport, leaseMilliseconds = 30_000, gestureIdFactory = randomUUID }) {
    this.transport = transport
    this.leaseMilliseconds = leaseMilliseconds
    this.gestureIdFactory = gestureIdFactory
    this.devices = new Map()
  }

  stateFor(simulatorUdid) {
    if (!this.devices.has(simulatorUdid)) {
      this.devices.set(simulatorUdid, {
        sockets: new Set(),
        owner: null,
        gesture: null,
        lastTouch: null,
        queue: [],
        pumping: false,
        leaseTimer: null,
        keepaliveTimer: null,
        edge: 0,
        moveCount: 0,
      })
    }
    return this.devices.get(simulatorUdid)
  }

  attach(socket, simulatorUdid) {
    const state = this.stateFor(simulatorUdid)
    state.sockets.add(socket)
    socketSend(socket, { type: "status", state: "connecting" })
    void this.transport.warm(simulatorUdid).then(
      () => socketSend(socket, { type: "status", state: "ready" }),
      (error) => socketSend(socket, { type: "error", message: error.message }),
    )
    if (!state.keepaliveTimer) {
      state.keepaliveTimer = setInterval(() => {
        if (state.sockets.size > 0) void this.transport.warm(simulatorUdid).catch(() => {})
      }, KEEPALIVE_INTERVAL_MS)
      state.keepaliveTimer.unref?.()
    }

    const onMessage = (data) => this.handleMessage(socket, simulatorUdid, data)
    const onClose = () => {
      socket.off?.("message", onMessage)
      socket.off?.("close", onClose)
      socket.off?.("error", onClose)
      this.detach(socket, simulatorUdid)
    }
    socket.on("message", onMessage)
    socket.on("close", onClose)
    socket.on("error", onClose)
  }

  detach(socket, simulatorUdid) {
    const state = this.devices.get(simulatorUdid)
    if (!state) return
    state.sockets.delete(socket)
    if (state.owner === socket) this.queueRelease(simulatorUdid, state, socket)
    if (state.sockets.size === 0 && state.keepaliveTimer) {
      clearInterval(state.keepaliveTimer)
      state.keepaliveTimer = null
    }
  }

  handleMessage(socket, simulatorUdid, data) {
    let touch
    try {
      touch = parseLiveTouch(data.toString())
    } catch (error) {
      socketSend(socket, { type: "error", message: error.message })
      return
    }
    const state = this.stateFor(simulatorUdid)
    if (touch.type === "begin") {
      if (state.owner && state.owner !== socket) {
        socketSend(socket, { type: "busy", message: "Another Codevisor pane is controlling this simulator" })
        return
      }
      if (state.owner === socket) return
      state.owner = socket
      state.gesture = this.gestureIdFactory()
      state.lastTouch = touch
      state.edge = touch.edge || 0
      state.moveCount = 0
      this.resetLease(simulatorUdid, state, socket)
      this.enqueue(simulatorUdid, state, { touch, gesture: state.gesture, coalesce: false, release: false })
      return
    }
    if (state.owner !== socket) return
    if (state.edge) touch.edge = state.edge
    state.lastTouch = touch
    this.resetLease(simulatorUdid, state, socket)
    if (touch.type === "move") {
      state.moveCount += 1
      this.enqueue(simulatorUdid, state, {
        touch,
        gesture: state.gesture,
        coalesce: !(state.edge && state.moveCount <= EDGE_MOVE_SAMPLES_TO_PRESERVE),
        release: false,
      })
    } else {
      this.enqueue(simulatorUdid, state, { touch, gesture: state.gesture, coalesce: false, release: true })
    }
  }

  resetLease(simulatorUdid, state, socket) {
    clearTimeout(state.leaseTimer)
    state.leaseTimer = setTimeout(() => this.queueRelease(simulatorUdid, state, socket), this.leaseMilliseconds)
    state.leaseTimer.unref?.()
  }

  queueRelease(simulatorUdid, state, socket) {
    if (state.owner !== socket || !state.lastTouch) return
    clearTimeout(state.leaseTimer)
    state.leaseTimer = null
    if (state.queue.some((item) => item.release)) return
    this.enqueue(simulatorUdid, state, {
      touch: { ...state.lastTouch, type: "end" },
      gesture: state.gesture,
      coalesce: false,
      release: true,
    })
  }

  enqueue(simulatorUdid, state, item) {
    if (item.coalesce && state.queue.at(-1)?.coalesce) state.queue[state.queue.length - 1] = item
    else state.queue.push(item)
    void this.pump(simulatorUdid, state)
  }

  releaseOwner(state, owner) {
    if (state.owner !== owner) return
    clearTimeout(state.leaseTimer)
    state.leaseTimer = null
    state.owner = null
    state.gesture = null
    state.lastTouch = null
    state.edge = 0
    state.moveCount = 0
  }

  async pump(simulatorUdid, state) {
    if (state.pumping) return
    state.pumping = true
    try {
      while (state.queue.length > 0) {
        const item = state.queue.shift()
        const owner = state.owner
        try {
          await this.transport.sendTouch(simulatorUdid, item.touch, item.gesture)
          if (item.release) this.releaseOwner(state, owner)
        } catch (error) {
          state.queue.length = 0
          const busy = error.message.includes("Another Codevisor session")
          socketSend(owner, { type: busy ? "busy" : "error", message: error.message })
          if (state.lastTouch) {
            try {
              await this.transport.sendTouch(
                simulatorUdid,
                { ...state.lastTouch, type: "end" },
                state.gesture,
              )
            } catch {}
          }
          this.releaseOwner(state, owner)
        }
      }
    } finally {
      state.pumping = false
      if (state.queue.length > 0) void this.pump(simulatorUdid, state)
    }
  }

  async close() {
    const releases = []
    for (const [simulatorUdid, state] of this.devices) {
      clearInterval(state.keepaliveTimer)
      clearTimeout(state.leaseTimer)
      if (!state.owner || !state.lastTouch) continue
      releases.push(this.transport.sendTouch(
        simulatorUdid,
        { ...state.lastTouch, type: "end" },
        state.gesture,
      ).catch(() => {}))
    }
    await Promise.all(releases)
    this.devices.clear()
  }
}
