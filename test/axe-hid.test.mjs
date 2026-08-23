import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { tmpdir } from "node:os"
import {
  brokerEndpointPath,
  fnv1a64,
  LiveTouchController,
  parseLiveTouch,
  rawEdgeForTouch,
  rawPointForTouch,
} from "../src/dtuhid.mjs"

const UDID = "D88404E3-C3F7-4C13-A657-7DFC66F18F09"
class FakeSocket extends EventEmitter {
  readyState = 1
  sent = []

  send(value) {
    this.sent.push(JSON.parse(value))
  }
}

async function waitFor(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("builds a stable versioned endpoint for the shared DTUHID broker", () => {
  assert.equal(fnv1a64("hello"), "a430d84680aabd0b")
  assert.equal(brokerEndpointPath({
    simulatorUdid: UDID,
    developerDirectory: "/Applications/Xcode-beta.app/Contents/Developer",
    temporaryDirectory: "/private/tmp",
  }), `/private/tmp/cvhid-${process.getuid()}/ab5268fa7bbeb82a-3a8b832b4b2d2949-v1.sock`)
  const realEndpoint = brokerEndpointPath({
    simulatorUdid: UDID,
    developerDirectory: "/Applications/Xcode-beta.app/Contents/Developer",
    temporaryDirectory: tmpdir(),
  })
  assert.ok(Buffer.byteLength(realEndpoint) < 104, `${realEndpoint} must fit sockaddr_un.sun_path`)
})

test("validates live touch messages", () => {
  assert.deepEqual(parseLiveTouch(JSON.stringify({
    type: "move",
    x: 0.25,
    y: 0.75,
    orientation: "landscape_left",
  })), { type: "move", x: 0.25, y: 0.75, orientation: "landscape_left" })
  assert.deepEqual(parseLiveTouch({
    type: "begin",
    x: 0.01,
    y: 0.5,
    edge: 1,
  }), { type: "begin", x: 0.01, y: 0.5, orientation: "portrait", edge: 1 })
  assert.throws(() => parseLiveTouch({ type: "move", x: 2, y: 0 }), /between 0 and 1/)
  assert.throws(() => parseLiveTouch({ type: "tap", x: 0, y: 0 }), /begin, move, or end/)
  assert.throws(() => parseLiveTouch({ type: "begin", x: 0, y: 0, edge: 5 }), /between 0 and 4/)
})

test("maps display points and semantic edges into raw portrait coordinates", () => {
  assert.deepEqual(rawPointForTouch({ x: 0.5, y: 0.25, orientation: "portrait" }), { x: 0.5, y: 0.25 })
  assert.deepEqual(rawPointForTouch({ x: 0.25, y: 0.75, orientation: "landscape_left" }), { x: 0.75, y: 0.75 })
  assert.deepEqual(rawPointForTouch({ x: 0.25, y: 0.75, orientation: "landscape_right" }), { x: 0.25, y: 0.25 })
  assert.equal(rawEdgeForTouch(3, "portrait"), 3)
  assert.equal(rawEdgeForTouch(3, "landscape_left"), 4)
  assert.equal(rawEdgeForTouch(1, "landscape_right"), 2)
})

test("gives one Codevisor socket exclusive ownership for a gesture", async () => {
  const delivered = []
  const controller = new LiveTouchController({
    transport: {
      warm: async () => {},
      sendTouch: async (_udid, touch, gesture) => delivered.push({ ...touch, gesture }),
    },
    gestureIdFactory: () => "gesture-one",
  })
  const first = new FakeSocket()
  const second = new FakeSocket()
  controller.attach(first, UDID)
  controller.attach(second, UDID)
  first.emit("message", Buffer.from(JSON.stringify({ type: "begin", x: 0.1, y: 0.2 })))
  second.emit("message", Buffer.from(JSON.stringify({ type: "begin", x: 0.8, y: 0.7 })))
  first.emit("message", Buffer.from(JSON.stringify({ type: "end", x: 0.1, y: 0.2 })))

  await waitFor(() => delivered.length === 2)
  assert.deepEqual(delivered.map((event) => event.type), ["begin", "end"])
  assert.ok(delivered.every((event) => event.gesture === "gesture-one"))
  assert.ok(second.sent.some((message) => message.type === "busy"))
  await controller.close()
})

test("coalesces queued pointer moves while preserving down and up", async () => {
  const delivered = []
  let releaseFirst
  const firstDelivery = new Promise((resolve) => { releaseFirst = resolve })
  const controller = new LiveTouchController({
    transport: {
      warm: async () => {},
      sendTouch: async (_udid, touch, gesture) => {
        delivered.push({ ...touch, gesture })
        if (delivered.length === 1) await firstDelivery
      },
    },
    gestureIdFactory: () => "gesture-two",
  })
  const socket = new FakeSocket()
  controller.attach(socket, UDID)
  socket.emit("message", Buffer.from(JSON.stringify({ type: "begin", x: 0.1, y: 0.1 })))
  await waitFor(() => delivered.length === 1)
  socket.emit("message", Buffer.from(JSON.stringify({ type: "move", x: 0.2, y: 0.2 })))
  socket.emit("message", Buffer.from(JSON.stringify({ type: "move", x: 0.7, y: 0.8 })))
  socket.emit("message", Buffer.from(JSON.stringify({ type: "end", x: 0.7, y: 0.8 })))
  releaseFirst()

  await waitFor(() => delivered.length === 3)
  assert.deepEqual(delivered.map((event) => event.type), ["begin", "move", "end"])
  assert.equal(delivered[1].x, 0.7)
  assert.equal(delivered[1].y, 0.8)
  assert.ok(delivered.every((event) => event.gesture === "gesture-two"))
  await controller.close()
})

test("routes an entire edge gesture through DTUHID and preserves its early samples", async () => {
  const delivered = []
  let releaseFirst
  const firstDelivery = new Promise((resolve) => { releaseFirst = resolve })
  const controller = new LiveTouchController({
    transport: {
      warm: async () => {},
      sendTouch: async (_udid, touch, gesture) => {
        delivered.push({ ...touch, gesture })
        if (delivered.length === 1) await firstDelivery
      },
    },
    gestureIdFactory: () => "edge-gesture",
  })
  const socket = new FakeSocket()
  controller.attach(socket, UDID)
  socket.emit("message", Buffer.from(JSON.stringify({ type: "begin", x: 0.01, y: 0.5, edge: 1 })))
  await waitFor(() => delivered.length === 1)
  for (let index = 1; index <= 6; index += 1) {
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "move",
      x: 0.01 + index * 0.04,
      y: 0.5,
    })))
  }
  socket.emit("message", Buffer.from(JSON.stringify({ type: "end", x: 0.3, y: 0.5 })))
  releaseFirst()

  await waitFor(() => delivered.at(-1)?.type === "end")
  assert.deepEqual(delivered.slice(0, 6).map((touch) => touch.type), [
    "begin", "move", "move", "move", "move", "move",
  ])
  assert.ok(delivered.every((touch) => touch.edge === 1))
  assert.ok(delivered.every((touch) => touch.gesture === "edge-gesture"))
  assert.equal(delivered.at(-1).type, "end")
  await controller.close()
})
