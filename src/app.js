const elements = {
  appearanceSelect: document.querySelector("#appearance-select"),
  canvas: document.querySelector("#stream-canvas"),
  colorFilterSelect: document.querySelector("#color-filter-select"),
  contrastToggle: document.querySelector("#contrast-toggle"),
  deviceList: document.querySelector("#device-list"),
  deviceMenuButton: document.querySelector("#device-menu-button"),
  deviceName: document.querySelector("#device-name"),
  devicePanel: document.querySelector("#device-panel"),
  deviceSearch: document.querySelector("#device-search"),
  deviceShell: document.querySelector("#device-shell"),
  emptyDetail: document.querySelector("#empty-detail"),
  emptyTitle: document.querySelector("#empty-title"),
  homeButton: document.querySelector("#home-button"),
  keyboardButton: document.querySelector("#keyboard-button"),
  liquidGlassSlider: document.querySelector("#liquid-glass-slider"),
  locationSelect: document.querySelector("#location-select"),
  lockButton: document.querySelector("#lock-button"),
  moreButton: document.querySelector("#more-button"),
  moreMenu: document.querySelector("#more-menu"),
  refreshButton: document.querySelector("#refresh-button"),
  reduceMotionToggle: document.querySelector("#reduce-motion-toggle"),
  reduceTransparencyToggle: document.querySelector("#reduce-transparency-toggle"),
  rotateLeftButton: document.querySelector("#rotate-left-button"),
  runtimeLabel: document.querySelector("#runtime-label"),
  screen: document.querySelector("#screen"),
  screenshotButton: document.querySelector("#screenshot-button"),
  settingsButton: document.querySelector("#settings-button"),
  settingsContent: document.querySelector("#settings-content"),
  settingsLoading: document.querySelector("#settings-loading"),
  settingsPanel: document.querySelector("#settings-panel"),
  showBordersToggle: document.querySelector("#show-borders-toggle"),
  shutdownButton: document.querySelector("#shutdown-button"),
  soundLabel: document.querySelector("#sound-label"),
  soundSlider: document.querySelector("#sound-slider"),
  startButton: document.querySelector("#start-button"),
  textSizeLabel: document.querySelector("#text-size-label"),
  textSizeSlider: document.querySelector("#text-size-slider"),
  toast: document.querySelector("#toast"),
  voiceOverToggle: document.querySelector("#voiceover-toggle"),
}

window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } })

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

const CONTENT_SIZES = [
  ["extra-small", "Extra Small"],
  ["small", "Small"],
  ["medium", "Medium"],
  ["large", "Large"],
  ["extra-large", "Extra Large"],
  ["extra-extra-large", "XX Large"],
  ["extra-extra-extra-large", "XXX Large"],
  ["accessibility-medium", "Accessibility M"],
  ["accessibility-large", "Accessibility L"],
  ["accessibility-extra-large", "Accessibility XL"],
  ["accessibility-extra-extra-large", "Accessibility XXL"],
  ["accessibility-extra-extra-extra-large", "Accessibility XXXL"],
]

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
let currentOrientation = "portrait"
let toastTimer
let openSurface = null
let settingsGeneration = 0
let currentSoundLevel = 8
const liquidGlassQueue = { running: false, next: null }
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

function setConnection(state) {
  elements.deviceMenuButton.dataset.connection = state
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

const SURFACES = {
  devices: [elements.devicePanel, elements.deviceMenuButton],
  settings: [elements.settingsPanel, elements.settingsButton],
  more: [elements.moreMenu, elements.moreButton],
}

function setOpenSurface(name) {
  for (const [surfaceName, [surface, button]] of Object.entries(SURFACES)) {
    const isOpen = surfaceName === name
    surface.hidden = !isOpen
    button?.setAttribute("aria-expanded", String(isOpen))
  }
  openSurface = name
  if (name === "devices") {
    populateDevices(currentState)
    requestAnimationFrame(() => elements.deviceSearch.focus())
  }
  if (name === "settings") void loadSettings()
}

function toggleSurface(name) {
  setOpenSurface(openSurface === name ? null : name)
}

function setControlsEnabled(enabled) {
  for (const button of [
    elements.homeButton,
    elements.keyboardButton,
    elements.lockButton,
    elements.rotateLeftButton,
    elements.screenshotButton,
    elements.shutdownButton,
  ]) button.disabled = !enabled
}

function populateDevices(state) {
  const selectedId = state.selected?.udid || ""
  const query = elements.deviceSearch.value.trim().toLocaleLowerCase()
  const groups = new Map()
  for (const device of state.devices.filter((candidate) => {
    if (!query) return true
    return `${candidate.name} ${candidate.runtime} ${candidate.deviceType}`.toLocaleLowerCase().includes(query)
  })) {
    const group = groups.get(device.runtime) || []
    group.push(device)
    groups.set(device.runtime, group)
  }
  elements.deviceList.replaceChildren()
  if (state.devices.length === 0) {
    const empty = document.createElement("p")
    empty.className = "device-list-empty"
    empty.textContent = "No simulators available"
    elements.deviceList.append(empty)
  } else if (groups.size === 0) {
    const empty = document.createElement("p")
    empty.className = "device-list-empty"
    empty.textContent = "No matching simulators"
    elements.deviceList.append(empty)
  } else {
    for (const [runtime, devices] of groups) {
      const group = document.createElement("section")
      group.className = "device-group"
      const heading = document.createElement("h3")
      heading.className = "device-group-title"
      heading.textContent = runtime
      group.append(heading)
      for (const device of devices) {
        const row = document.createElement("button")
        row.type = "button"
        row.className = `device-row${device.udid === selectedId ? " is-selected" : ""}${device.state === "Booted" ? " is-booted" : ""}`
        row.dataset.udid = device.udid
        row.innerHTML = `
          <span class="device-row-icon"><i data-lucide="smartphone"></i></span>
          <span class="device-row-copy"><strong></strong><span></span></span>
          <span class="device-row-state"></span>
        `
        row.querySelector("strong").textContent = device.name
        row.querySelector(".device-row-copy span").textContent = "Simulator"
        row.querySelector(".device-row-state").textContent = device.state === "Booted" ? "Live" : "Off"
        group.append(row)
      }
      elements.deviceList.append(group)
    }
  }
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } })
  elements.deviceName.textContent = state.selected?.name || "No Simulator"
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
    if (openSurface === "settings") void loadSettings()
    return
  }

  if (window.codevisor?.setTitle) window.codevisor.setTitle(selected.name)
  if (selected.state !== "Booted") {
    stopDeviceSession()
    setControlsEnabled(false)
    setEmpty(`${selected.name} is shut down`, `Start ${selected.runtime} to view it here.`, "Start simulator")
    setConnection("waiting", "Shut down")
    if (openSurface === "settings" && previous?.udid !== selected.udid) void loadSettings()
    return
  }

  if (reconnect || previous?.udid !== selected.udid || previous?.state !== "Booted") {
    startDeviceSession(selected)
  }
  if (openSurface === "settings" && previous?.udid !== selected.udid) void loadSettings()
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

function setSettingsPending(pending) {
  elements.settingsLoading.hidden = !pending
  elements.settingsContent.hidden = pending
}

function applySettingsState(settings) {
  const simulator = settings.simulator || {}
  const appearanceSupported = simulator.appearance === "light" || simulator.appearance === "dark"
  elements.appearanceSelect.disabled = !appearanceSupported
  if (appearanceSupported) elements.appearanceSelect.value = simulator.appearance

  const liquidGlassSupported = typeof simulator.liquidGlassOpacity === "number"
  elements.liquidGlassSlider.disabled = !liquidGlassSupported
  if (liquidGlassSupported) {
    const percentage = Math.round(simulator.liquidGlassOpacity * 100)
    elements.liquidGlassSlider.value = String(simulator.liquidGlassOpacity)
    elements.liquidGlassSlider.setAttribute("aria-valuetext", `${percentage}% tint`)
  }

  const colorFilterSupported = ["none", "grayscale", "red-green", "green-red", "blue-yellow"].includes(simulator.colorFilter)
  elements.colorFilterSelect.disabled = !colorFilterSupported
  if (colorFilterSupported) elements.colorFilterSelect.value = simulator.colorFilter

  const contentSizeIndex = CONTENT_SIZES.findIndex(([value]) => value === simulator.contentSize)
  elements.textSizeSlider.disabled = contentSizeIndex < 0
  if (contentSizeIndex >= 0) {
    elements.textSizeSlider.value = String(contentSizeIndex)
    elements.textSizeLabel.textContent = CONTENT_SIZES[contentSizeIndex][1]
  } else {
    elements.textSizeLabel.textContent = "Unavailable"
  }

  for (const [control, value] of [
    [elements.reduceMotionToggle, simulator.reduceMotion],
    [elements.contrastToggle, simulator.increaseContrast],
    [elements.showBordersToggle, simulator.showBorders],
    [elements.reduceTransparencyToggle, simulator.reduceTransparency],
    [elements.voiceOverToggle, simulator.voiceOver],
  ]) {
    control.disabled = value === null
    if (value !== null) control.checked = value
  }

  elements.locationSelect.value = settings.location || "none"
  currentSoundLevel = Number.isInteger(settings.audio?.sound) ? settings.audio.sound : 8
  elements.soundSlider.value = String(currentSoundLevel)
  elements.soundLabel.textContent = `${Math.round(currentSoundLevel / 16 * 100)}%`
  setSettingsPending(false)
}

async function loadSettings() {
  const device = currentState.selected
  const generation = ++settingsGeneration
  if (!device) {
    setSettingsPending(true)
    elements.settingsLoading.textContent = "Select a simulator to change its display."
    return
  }
  setSettingsPending(true)
  elements.settingsLoading.textContent = "Loading settings…"
  try {
    const settings = await api(`api/settings?udid=${encodeURIComponent(device.udid)}`)
    if (generation === settingsGeneration) applySettingsState(settings)
  } catch (error) {
    if (generation !== settingsGeneration) return
    elements.settingsLoading.textContent = "Settings are unavailable for this simulator."
    showToast(error.message)
  }
}

async function updateSettings(change, { applyResponse = true } = {}) {
  const device = currentState.selected
  if (!device) return
  try {
    const settings = await api("api/settings", {
      method: "POST",
      body: { udid: device.udid, ...change },
    })
    if (applyResponse) applySettingsState(settings)
    return settings
  } catch (error) {
    showToast(error.message)
    await loadSettings()
  }
}

function queueLiquidGlassOpacity(value) {
  liquidGlassQueue.next = value
  if (liquidGlassQueue.running) return
  liquidGlassQueue.running = true
  void (async () => {
    let latestSettings
    while (liquidGlassQueue.next !== null) {
      const next = liquidGlassQueue.next
      liquidGlassQueue.next = null
      latestSettings = await updateSettings({ liquidGlassOpacity: next }, { applyResponse: false })
    }
    if (latestSettings) applySettingsState(latestSettings)
    liquidGlassQueue.running = false
  })()
}

function setSimulatorSound(nextLevel) {
  const previousLevel = currentSoundLevel
  currentSoundLevel = nextLevel
  const difference = nextLevel - previousLevel
  const generation = streamGeneration
  const payload = difference > 0
    ? { button: "volume-up", page: 12, usage: 233 }
    : { button: "volume-down", page: 12, usage: 234 }
  for (let index = 0; index < Math.abs(difference); index += 1) {
    setTimeout(() => {
      if (generation === streamGeneration) sendInput(0x04, payload)
    }, index * 24)
  }
  void updateSettings({ sound: nextLevel })
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

elements.deviceMenuButton.addEventListener("click", () => toggleSurface("devices"))
elements.settingsButton.addEventListener("click", () => toggleSurface("settings"))
elements.moreButton.addEventListener("click", () => toggleSurface("more"))
for (const button of document.querySelectorAll("[data-close-panel]")) {
  button.addEventListener("click", () => setOpenSurface(null))
}
elements.deviceSearch.addEventListener("input", () => populateDevices(currentState))
elements.deviceList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-udid]")
  if (!row) return
  setOpenSurface(null)
  void selectDevice(row.dataset.udid)
})
elements.keyboardButton.addEventListener("click", () => {
  elements.screen.classList.remove("is-pointer-focused")
  elements.screen.focus({ preventScroll: true })
})
elements.appearanceSelect.addEventListener("change", () => void updateSettings({ appearance: elements.appearanceSelect.value }))
elements.liquidGlassSlider.addEventListener("input", () => {
  const opacity = Number(elements.liquidGlassSlider.value)
  elements.liquidGlassSlider.setAttribute("aria-valuetext", `${Math.round(opacity * 100)}% tint`)
  queueLiquidGlassOpacity(opacity)
})
elements.colorFilterSelect.addEventListener("change", () => void updateSettings({ colorFilter: elements.colorFilterSelect.value }))
elements.textSizeSlider.addEventListener("input", () => {
  elements.textSizeLabel.textContent = CONTENT_SIZES[Number(elements.textSizeSlider.value)]?.[1] || "Large"
})
elements.textSizeSlider.addEventListener("change", () => {
  const contentSize = CONTENT_SIZES[Number(elements.textSizeSlider.value)]?.[0]
  if (contentSize) void updateSettings({ contentSize })
})
elements.reduceMotionToggle.addEventListener("change", () => void updateSettings({ reduceMotion: elements.reduceMotionToggle.checked }))
elements.contrastToggle.addEventListener("change", () => void updateSettings({ increaseContrast: elements.contrastToggle.checked }))
elements.showBordersToggle.addEventListener("change", () => void updateSettings({ showBorders: elements.showBordersToggle.checked }))
elements.reduceTransparencyToggle.addEventListener("change", () => void updateSettings({ reduceTransparency: elements.reduceTransparencyToggle.checked }))
elements.voiceOverToggle.addEventListener("change", () => void updateSettings({ voiceOver: elements.voiceOverToggle.checked }))
elements.locationSelect.addEventListener("change", () => void updateSettings({ location: elements.locationSelect.value }))
elements.soundSlider.addEventListener("input", () => {
  elements.soundLabel.textContent = `${Math.round(Number(elements.soundSlider.value) / 16 * 100)}%`
})
elements.soundSlider.addEventListener("change", () => setSimulatorSound(Number(elements.soundSlider.value)))
document.addEventListener("click", (event) => {
  if (openSurface !== "info" && openSurface !== "more") return
  const [surface, trigger] = SURFACES[openSurface]
  if (!surface.contains(event.target) && !trigger.contains(event.target)) setOpenSurface(null)
})
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openSurface) {
    event.preventDefault()
    setOpenSurface(null)
  }
}, true)
elements.refreshButton.addEventListener("click", () => {
  setOpenSurface(null)
  void refreshState({ reconnect: true })
})
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
  setOpenSurface(null)
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

setInterval(() => void refreshState(), 5000)
void refreshState({ reconnect: true })
