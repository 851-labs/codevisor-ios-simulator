const elements = {
  canvas: document.querySelector("#stream-canvas"),
  connection: document.querySelector(".connection"),
  connectionLabel: document.querySelector("#connection-label"),
  deviceSelect: document.querySelector("#device-select"),
  deviceShell: document.querySelector("#device-shell"),
  emptyDetail: document.querySelector("#empty-detail"),
  emptyTitle: document.querySelector("#empty-title"),
  frameRate: document.querySelector("#frame-rate"),
  homeButton: document.querySelector("#home-button"),
  lockButton: document.querySelector("#lock-button"),
  refreshButton: document.querySelector("#refresh-button"),
  rotateLeftButton: document.querySelector("#rotate-left-button"),
  runtimeLabel: document.querySelector("#runtime-label"),
  screen: document.querySelector("#screen"),
  screenSize: document.querySelector("#screen-size"),
  screenshotButton: document.querySelector("#screenshot-button"),
  shutdownButton: document.querySelector("#shutdown-button"),
  startButton: document.querySelector("#start-button"),
  toast: document.querySelector("#toast"),
}

const HID_USAGE_BY_CODE = {
  KeyA: 0x04, KeyB: 0x05, KeyC: 0x06, KeyD: 0x07, KeyE: 0x08, KeyF: 0x09,
  KeyG: 0x0a, KeyH: 0x0b, KeyI: 0x0c, KeyJ: 0x0d, KeyK: 0x0e, KeyL: 0x0f,
  KeyM: 0x10, KeyN: 0x11, KeyO: 0x12, KeyP: 0x13, KeyQ: 0x14, KeyR: 0x15,
  KeyS: 0x16, KeyT: 0x17, KeyU: 0x18, KeyV: 0x19, KeyW: 0x1a, KeyX: 0x1b,
  KeyY: 0x1c, KeyZ: 0x1d,
  Digit1: 0x1e, Digit2: 0x1f, Digit3: 0x20, Digit4: 0x21, Digit5: 0x22,
  Digit6: 0x23, Digit7: 0x24, Digit8: 0x25, Digit9: 0x26, Digit0: 0x27,
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30,
  Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
  Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
  Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
  ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
  ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
}

const ROTATE_LEFT = {
  portrait: "landscape_left",
  landscape_left: "portrait_upside_down",
  portrait_upside_down: "landscape_right",
  landscape_right: "portrait",
}

let currentState = { devices: [], selected: null }
let streamAbort
let streamGeneration = 0
let inputSocket
let inputReconnectTimer
let touchSocket
let touchReconnectTimer
let queuedTouchMessages = []
let frameBlob
let renderingFrame = false
let frameCounter = 0
let frameCounterStartedAt = performance.now()
let currentOrientation = "portrait"
let toastTimer
let activePointer = null
let pendingPointerMove = null
let pointerMoveFrame = null
const pressedKeys = new Set()

function relativeUrl(path) {
  return new URL(path, window.location.href)
}

function websocketUrl(path) {
  const url = relativeUrl(path)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (options.body && typeof options.body !== "string") {
    headers["Content-Type"] = "application/json"
    options = { ...options, body: JSON.stringify(options.body) }
  }
  const response = await fetch(path, { ...options, headers })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = await response.json()
      if (body.error) message = body.error
    } catch {}
    throw new Error(message)
  }
  return response.json()
}

function setConnection(state, label) {
  elements.connection.dataset.state = state
  elements.connectionLabel.textContent = label
}

function setEmpty(title, detail, action = null) {
  elements.deviceShell.classList.add("is-idle")
  elements.emptyTitle.textContent = title
  elements.emptyDetail.textContent = detail
  elements.startButton.hidden = !action
  elements.startButton.textContent = action || "Start simulator"
}

function showToast(message) {
  clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.classList.add("is-visible")
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2600)
}

function setControlsEnabled(enabled) {
  for (const button of [
    elements.homeButton,
    elements.lockButton,
    elements.rotateLeftButton,
    elements.screenshotButton,
    elements.shutdownButton,
  ]) button.disabled = !enabled
}

function populateDevices(state) {
  const selectedId = state.selected?.udid || ""
  const groups = new Map()
  for (const device of state.devices) {
    const group = groups.get(device.runtime) || []
    group.push(device)
    groups.set(device.runtime, group)
  }
  elements.deviceSelect.replaceChildren()
  if (state.devices.length === 0) {
    const option = document.createElement("option")
    option.textContent = "No simulators available"
    option.disabled = true
    option.selected = true
    elements.deviceSelect.append(option)
    elements.deviceSelect.disabled = true
  } else {
    elements.deviceSelect.disabled = false
    for (const [runtime, devices] of groups) {
      const optgroup = document.createElement("optgroup")
      optgroup.label = runtime
      for (const device of devices) {
        const option = document.createElement("option")
        option.value = device.udid
        option.textContent = `${device.state === "Booted" ? "● " : ""}${device.name}`
        option.selected = device.udid === selectedId
        optgroup.append(option)
      }
      elements.deviceSelect.append(optgroup)
    }
  }
  elements.runtimeLabel.textContent = state.selected?.runtime || ""
}

async function renderFrame(blob, generation) {
  frameBlob = blob
  if (renderingFrame) return
  renderingFrame = true
  try {
    while (frameBlob && generation === streamGeneration) {
      const next = frameBlob
      frameBlob = null
      const bitmap = await createImageBitmap(next)
      if (generation !== streamGeneration) {
        bitmap.close()
        break
      }
      if (elements.canvas.width !== bitmap.width || elements.canvas.height !== bitmap.height) {
        elements.canvas.width = bitmap.width
        elements.canvas.height = bitmap.height
        updateScreenConfig(bitmap.width, bitmap.height, currentOrientation)
      }
      elements.canvas.getContext("2d", { alpha: false }).drawImage(bitmap, 0, 0)
      bitmap.close()
      frameCounter += 1
      elements.deviceShell.classList.remove("is-idle")
      setConnection("live", "Live")
    }
  } catch (error) {
    console.warn("Frame decode failed", error)
  } finally {
    renderingFrame = false
  }
}

function createMjpegParser(emit) {
  let buffer = new Uint8Array(64 * 1024)
  let length = 0
  let cursor = 0
  const decoder = new TextDecoder("latin1")

  function append(value) {
    if (length + value.length > buffer.length) {
      if (cursor > 0) {
        buffer.copyWithin(0, cursor, length)
        length -= cursor
        cursor = 0
      }
      if (length + value.length > buffer.length) {
        let capacity = buffer.length
        while (capacity < length + value.length) capacity *= 2
        const grown = new Uint8Array(capacity)
        grown.set(buffer.subarray(0, length))
        buffer = grown
      }
    }
    buffer.set(value, length)
    length += value.length
  }

  function findHeaderEnd() {
    const limit = Math.min(length - 3, cursor + 1024)
    for (let index = cursor; index < limit; index += 1) {
      if (buffer[index] === 13 && buffer[index + 1] === 10 && buffer[index + 2] === 13 && buffer[index + 3] === 10) return index
    }
    return -1
  }

  function drain() {
    while (cursor < length) {
      const headerEnd = findHeaderEnd()
      if (headerEnd < 0) break
      const header = decoder.decode(buffer.subarray(cursor, headerEnd))
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        cursor = headerEnd + 4
        continue
      }
      const frameLength = Number(match[1])
      const frameStart = headerEnd + 4
      const frameEnd = frameStart + frameLength
      if (length < frameEnd) break
      emit(new Blob([buffer.subarray(frameStart, frameEnd)], { type: "image/jpeg" }))
      cursor = frameEnd
    }
    if (cursor > 0) {
      if (cursor < length) buffer.copyWithin(0, cursor, length)
      length -= cursor
      cursor = 0
    }
  }

  return {
    push(value) {
      if (!value?.length) return
      append(value)
      drain()
    },
  }
}

async function readStream(device, generation) {
  const parser = createMjpegParser((blob) => void renderFrame(blob, generation))
  while (generation === streamGeneration) {
    streamAbort = new AbortController()
    try {
      const response = await fetch(`helper/${encodeURIComponent(device.udid)}/stream.mjpeg?raw=1`, {
        signal: streamAbort.signal,
        cache: "no-store",
      })
      if (!response.ok || !response.body) throw new Error(`Stream returned ${response.status}`)
      const reader = response.body.getReader()
      while (generation === streamGeneration) {
        const { done, value } = await reader.read()
        if (done) break
        parser.push(value)
      }
    } catch (error) {
      if (streamAbort.signal.aborted || generation !== streamGeneration) return
      console.warn("Simulator stream disconnected", error)
      setConnection("waiting", "Reconnecting")
    }
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
}

function encodeMessage(tag, payload) {
  const body = new TextEncoder().encode(JSON.stringify(payload))
  const message = new Uint8Array(body.length + 1)
  message[0] = tag
  message.set(body, 1)
  return message
}

function sendInput(tag, payload) {
  if (inputSocket?.readyState === WebSocket.OPEN) inputSocket.send(encodeMessage(tag, payload))
}

function queueTouchMessage(payload) {
  if (touchSocket?.readyState === WebSocket.OPEN) {
    touchSocket.send(JSON.stringify(payload))
    return
  }
  if (payload.type === "move" && queuedTouchMessages.at(-1)?.type === "move") {
    queuedTouchMessages[queuedTouchMessages.length - 1] = payload
  } else {
    queuedTouchMessages.push(payload)
  }
  if (queuedTouchMessages.length > 32) queuedTouchMessages.splice(1, queuedTouchMessages.length - 32)
}

function connectLiveTouch(device, generation) {
  clearTimeout(touchReconnectTimer)
  touchSocket?.close()
  const connect = () => {
    if (generation !== streamGeneration) return
    const socket = new WebSocket(websocketUrl(`input/${encodeURIComponent(device.udid)}/ws`))
    touchSocket = socket
    socket.addEventListener("open", () => {
      const queued = queuedTouchMessages
      queuedTouchMessages = []
      for (const message of queued) socket.send(JSON.stringify(message))
    })
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      try {
        const message = JSON.parse(event.data)
        if (message.type === "busy") {
          clearActivePointer()
          showToast(message.message || "Another pane is controlling this simulator")
        } else if (message.type === "error") {
          showToast(message.message || "Simulator input failed")
        }
      } catch {}
    })
    socket.addEventListener("close", () => {
      if (generation !== streamGeneration) return
      if (activePointer) clearActivePointer()
      queuedTouchMessages = []
      touchReconnectTimer = setTimeout(connect, 900)
    })
    socket.addEventListener("error", () => socket.close())
  }
  connect()
}

function connectInput(device, generation) {
  clearTimeout(inputReconnectTimer)
  inputSocket?.close()
  const connect = () => {
    if (generation !== streamGeneration) return
    const socket = new WebSocket(websocketUrl(`helper/${encodeURIComponent(device.udid)}/ws`))
    socket.binaryType = "arraybuffer"
    inputSocket = socket
    socket.addEventListener("open", () => setConnection(frameCounter ? "live" : "waiting", frameCounter ? "Live" : "Waiting for video"))
    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) return
      const data = new Uint8Array(event.data)
      if (data[0] !== 0x82) return
      try {
        const config = JSON.parse(new TextDecoder().decode(data.subarray(1)))
        updateScreenConfig(config.width, config.height, config.orientation)
      } catch {}
    })
    socket.addEventListener("close", () => {
      if (generation !== streamGeneration) return
      setConnection("waiting", "Reconnecting input")
      inputReconnectTimer = setTimeout(connect, 900)
    })
    socket.addEventListener("error", () => socket.close())
  }
  connect()
}

function updateScreenConfig(width, height, orientation = "portrait") {
  if (!(width > 0 && height > 0)) return
  currentOrientation = orientation || currentOrientation
  elements.deviceShell.style.setProperty("--screen-ratio", `${width} / ${height}`)
  elements.screenSize.textContent = `${width} × ${height}`
}

function stopDeviceSession() {
  streamGeneration += 1
  streamAbort?.abort()
  inputSocket?.close()
  inputSocket = null
  touchSocket?.close()
  touchSocket = null
  clearTimeout(inputReconnectTimer)
  clearTimeout(touchReconnectTimer)
  queuedTouchMessages = []
  clearActivePointer()
  frameBlob = null
  frameCounter = 0
  frameCounterStartedAt = performance.now()
  elements.canvas.getContext("2d").clearRect(0, 0, elements.canvas.width, elements.canvas.height)
}

function startDeviceSession(device) {
  stopDeviceSession()
  const generation = streamGeneration
  setEmpty("Connecting to Simulator", "The first frame can take a few seconds.")
  setConnection("waiting", "Connecting")
  setControlsEnabled(true)
  void readStream(device, generation)
  connectInput(device, generation)
  if (device.inputTransport === "dtuhid") connectLiveTouch(device, generation)
}

function renderState(nextState, { reconnect = false } = {}) {
  const previous = currentState.selected
  currentState = nextState
  populateDevices(nextState)
  const selected = nextState.selected
  if (!selected) {
    stopDeviceSession()
    setControlsEnabled(false)
    setEmpty("No iOS Simulators", "Install an iOS runtime in Xcode to begin.")
    setConnection("error", "No simulator")
    return
  }

  if (window.codevisor?.setTitle) window.codevisor.setTitle(selected.name)
  if (selected.state !== "Booted") {
    stopDeviceSession()
    setControlsEnabled(false)
    setEmpty(`${selected.name} is shut down`, `Start ${selected.runtime} to view it here.`, "Start simulator")
    setConnection("waiting", "Shut down")
    return
  }

  if (reconnect || previous?.udid !== selected.udid || previous?.state !== "Booted") {
    startDeviceSession(selected)
  }
}

async function refreshState(options) {
  try {
    renderState(await api("api/state"), options)
  } catch (error) {
    setConnection("error", "Unavailable")
    setEmpty("Simulator unavailable", error.message)
    showToast(error.message)
  }
}

async function selectDevice(udid) {
  stopDeviceSession()
  setEmpty("Starting Simulator", "Booting the selected device…")
  setConnection("waiting", "Starting")
  try {
    renderState(await api("api/device/select", { method: "POST", body: { udid, boot: true } }), { reconnect: true })
  } catch (error) {
    showToast(error.message)
    await refreshState()
  }
}

function pointerPosition(clientX, clientY) {
  const rect = elements.screen.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  }
}

function edgeForPoint(point) {
  if (point.y >= 0.93) return 3
  if (point.x <= 0.04) return 1
  if (point.y <= 0.035) return 2
  if (point.x >= 0.965) return 4
  return undefined
}

function touchPayload(type, point, edge) {
  return edge === undefined ? { type, ...point } : { type, ...point, edge }
}

function clearActivePointer() {
  activePointer = null
  pendingPointerMove = null
  if (pointerMoveFrame !== null) cancelAnimationFrame(pointerMoveFrame)
  pointerMoveFrame = null
}

function usesLiveTouchInput() {
  return currentState.selected?.inputTransport === "dtuhid"
}

function beginPointer(kind, id, clientX, clientY) {
  if (!currentState.selected || currentState.selected.state !== "Booted" || activePointer !== null) return false
  const point = pointerPosition(clientX, clientY)
  const edge = edgeForPoint(point)
  activePointer = { kind, id, edge, point, start: point, startedAt: performance.now(), moved: false }
  elements.screen.classList.add("is-pointer-focused")
  elements.screen.focus({ preventScroll: true })
  if (usesLiveTouchInput()) queueTouchMessage({
    ...touchPayload("begin", point, edge),
    orientation: currentOrientation,
  })
  else sendInput(0x03, touchPayload("begin", point, edge))
  return true
}

function movePointer(kind, id, clientX, clientY) {
  if (activePointer?.kind !== kind || activePointer.id !== id) return false
  pendingPointerMove = pointerPosition(clientX, clientY)
  if (Math.hypot(
    pendingPointerMove.x - activePointer.start.x,
    pendingPointerMove.y - activePointer.start.y,
  ) >= 0.008) activePointer.moved = true
  if (pointerMoveFrame !== null) return true
  pointerMoveFrame = requestAnimationFrame(() => {
    pointerMoveFrame = null
    if (!activePointer || !pendingPointerMove) return
    activePointer.point = pendingPointerMove
    if (usesLiveTouchInput()) {
      queueTouchMessage({
        ...touchPayload("move", pendingPointerMove, activePointer.edge),
        orientation: currentOrientation,
      })
    } else {
      sendInput(0x03, touchPayload("move", pendingPointerMove, activePointer.edge))
    }
    pendingPointerMove = null
  })
  return true
}

function endPointer(kind, id, clientX, clientY) {
  if (activePointer?.kind !== kind || activePointer.id !== id) return false
  const point = clientX === undefined || clientY === undefined
    ? activePointer.point
    : pointerPosition(clientX, clientY)
  if (usesLiveTouchInput()) {
    queueTouchMessage({
      ...touchPayload("end", point, activePointer.edge),
      orientation: currentOrientation,
    })
  } else {
    sendInput(0x03, touchPayload("end", point, activePointer.edge))
  }
  clearActivePointer()
  return true
}

function findTouch(touchList, identifier) {
  for (const touch of touchList) {
    if (touch.identifier === identifier) return touch
  }
  return null
}

function releasePressedKeys() {
  for (const usage of pressedKeys) sendInput(0x06, { type: "up", usage })
  pressedKeys.clear()
}

elements.deviceSelect.addEventListener("change", () => void selectDevice(elements.deviceSelect.value))
elements.refreshButton.addEventListener("click", () => void refreshState({ reconnect: true }))
elements.startButton.addEventListener("click", () => currentState.selected && void selectDevice(currentState.selected.udid))
elements.homeButton.addEventListener("click", () => sendInput(0x04, { button: "home" }))
elements.lockButton.addEventListener("click", () => sendInput(0x04, { button: "lock" }))
elements.rotateLeftButton.addEventListener("click", () => {
  const orientation = ROTATE_LEFT[currentOrientation] || "landscape_left"
  sendInput(0x07, { orientation })
  currentOrientation = orientation
})
elements.screenshotButton.addEventListener("click", async () => {
  if (!currentState.selected) return
  try {
    const response = await fetch(`api/screenshot?udid=${encodeURIComponent(currentState.selected.udid)}`)
    if (!response.ok) throw new Error("Screenshot failed")
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${currentState.selected.name.replaceAll(" ", "-").toLowerCase()}.png`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    showToast("Screenshot saved")
  } catch (error) {
    showToast(error.message)
  }
})
elements.shutdownButton.addEventListener("click", async () => {
  if (!currentState.selected) return
  try {
    renderState(await api("api/device/shutdown", { method: "POST", body: { udid: currentState.selected.udid } }))
  } catch (error) {
    showToast(error.message)
  }
})

elements.screen.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  beginPointer("mouse", 0, event.clientX, event.clientY)
})

window.addEventListener("mousemove", (event) => {
  if (activePointer?.kind !== "mouse") return
  event.preventDefault()
  movePointer("mouse", 0, event.clientX, event.clientY)
})

window.addEventListener("mouseup", (event) => {
  if (event.button !== 0 || activePointer?.kind !== "mouse") return
  event.preventDefault()
  endPointer("mouse", 0, event.clientX, event.clientY)
})

elements.screen.addEventListener("touchstart", (event) => {
  const touch = event.changedTouches[0]
  if (!touch) return
  event.preventDefault()
  beginPointer("touch", touch.identifier, touch.clientX, touch.clientY)
}, { passive: false })

elements.screen.addEventListener("touchmove", (event) => {
  if (activePointer?.kind !== "touch") return
  const touch = findTouch(event.touches, activePointer.id)
  if (!touch) return
  event.preventDefault()
  movePointer("touch", touch.identifier, touch.clientX, touch.clientY)
}, { passive: false })

function finishTouch(event) {
  if (activePointer?.kind !== "touch") return
  const touch = findTouch(event.changedTouches, activePointer.id)
  if (!touch) return
  event.preventDefault()
  endPointer("touch", touch.identifier, touch.clientX, touch.clientY)
}

elements.screen.addEventListener("touchend", finishTouch, { passive: false })
elements.screen.addEventListener("touchcancel", finishTouch, { passive: false })
window.addEventListener("keydown", (event) => {
  if (event.key === "Tab") elements.screen.classList.remove("is-pointer-focused")
}, true)
elements.screen.addEventListener("keydown", (event) => {
  const usage = HID_USAGE_BY_CODE[event.code]
  if (usage == null) return
  event.preventDefault()
  if (!event.repeat) pressedKeys.add(usage)
  sendInput(0x06, { type: "down", usage })
})
elements.screen.addEventListener("keyup", (event) => {
  const usage = HID_USAGE_BY_CODE[event.code]
  if (usage == null) return
  event.preventDefault()
  pressedKeys.delete(usage)
  sendInput(0x06, { type: "up", usage })
})
elements.screen.addEventListener("blur", () => {
  releasePressedKeys()
})
window.addEventListener("blur", () => {
  releasePressedKeys()
  if (activePointer) endPointer(activePointer.kind, activePointer.id)
})

setInterval(() => {
  const now = performance.now()
  const seconds = (now - frameCounterStartedAt) / 1000
  elements.frameRate.textContent = frameCounter > 0 ? `${Math.round(frameCounter / Math.max(seconds, 0.1))} fps` : "Waiting for frames"
  frameCounter = 0
  frameCounterStartedAt = now
}, 1000)

setInterval(() => void refreshState(), 5000)
void refreshState({ reconnect: true })
