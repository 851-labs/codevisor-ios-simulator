import assert from "node:assert/strict"
import { test } from "node:test"
import {
  decodeContext,
  hasCodevisorPaneContext,
  inputTransportForRuntime,
  isLiquidGlassOpacity,
  panePreferenceKey,
  parseDeviceList,
  runtimeLabel,
} from "../server.mjs"

test("decodes Codevisor context and scopes preferences to a pane", () => {
  const header = Buffer.from(JSON.stringify({ paneId: "pane-1", workspaceId: "workspace-1" })).toString("base64")
  const context = decodeContext(header)
  assert.equal(context.paneId, "pane-1")
  assert.equal(panePreferenceKey(context), "pane:pane-1")
})

test("falls back through workspace, cwd, and global preference scopes", () => {
  assert.equal(panePreferenceKey({ workspaceId: "work-1", cwd: "/repo" }), "workspace:work-1")
  assert.equal(panePreferenceKey({ cwd: "/repo" }), "cwd:/repo")
  assert.equal(panePreferenceKey({}), "global")
  assert.deepEqual(decodeContext("not-base64-json"), {})
})

test("accepts Codevisor-proxied pane context independently of rewritten host headers", () => {
  const context = Buffer.from(JSON.stringify({ paneId: "pane-1" })).toString("base64")
  assert.equal(hasCodevisorPaneContext({
    headers: {
      host: "127.0.0.1:61280",
      origin: "http://127.0.0.1:49361",
      "x-codevisor-context": context,
    },
  }), true)
  assert.equal(hasCodevisorPaneContext({ headers: { origin: "https://example.com" } }), false)
})

test("formats CoreSimulator runtime identifiers", () => {
  assert.equal(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-27-0"), "iOS 27.0")
})

test("parses available devices with booted devices first", () => {
  const devices = parseDeviceList({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
        {
          name: "iPhone 17 Pro",
          udid: "D88404E3-C3F7-4C13-A657-7DFC66F18F09",
          state: "Booted",
          isAvailable: true,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        {
          name: "Unavailable",
          udid: "B6C65D59-8E21-4BC5-BA1A-9B7BAC650665",
          state: "Shutdown",
          isAvailable: false,
        },
        {
          name: "iPhone 17",
          udid: "9A4AE5EE-8916-4624-B10B-A00F0EAEF7A4",
          state: "Shutdown",
          isAvailable: true,
        },
      ],
    },
  })
  assert.deepEqual(devices.map((device) => device.name), ["iPhone 17 Pro", "iPhone 17"])
  assert.equal(devices[0].runtime, "iOS 27.0")
})

test("uses raw DTUHID input for iOS 27 and legacy HID for older runtimes", () => {
  assert.equal(inputTransportForRuntime("iOS 27.0"), "dtuhid")
  assert.equal(inputTransportForRuntime("iOS 26.4"), "legacy-hid")
  assert.equal(inputTransportForRuntime("watchOS 27.0"), "legacy-hid")
})

test("accepts Device Hub's continuous Liquid Glass opacity range", () => {
  assert.equal(isLiquidGlassOpacity(0), true)
  assert.equal(isLiquidGlassOpacity(0.5165625214576721), true)
  assert.equal(isLiquidGlassOpacity(1), true)
  assert.equal(isLiquidGlassOpacity(-0.01), false)
  assert.equal(isLiquidGlassOpacity(1.01), false)
  assert.equal(isLiquidGlassOpacity(Number.NaN), false)
})
