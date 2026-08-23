import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import test from "node:test"

const runtimeFiles = [
  "vendor/serve-sim/middleware.js",
  "vendor/serve-sim/native/serve-sim-native.node",
  "vendor/serve-sim/simax/serve-sim-ax-settings",
]

test("ships the serve-sim runtime without Git or reference repositories", async () => {
  await Promise.all(runtimeFiles.map((path) => access(path)))

  const [installer, server] = await Promise.all([
    readFile("scripts/install.sh", "utf8"),
    readFile("server.mjs", "utf8"),
  ])

  assert.doesNotMatch(installer, /\bgit\b/i)
  assert.doesNotMatch(installer, /\.repos/)
  assert.doesNotMatch(server, /\.repos/)
})
