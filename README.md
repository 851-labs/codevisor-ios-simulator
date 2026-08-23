# Codevisor iOS Simulator

View and control a locally running iOS Simulator from a Codevisor pane, including from remote Codevisor clients.

The plugin includes the small portion of `serve-sim` it needs for SimulatorKit framebuffer capture and legacy HID injection on older runtimes. On iOS 27, a native broker sends normalized `IndigoDigitizerEvent` messages directly to the simulator's modern DTUHID service. Regular and system-edge touches share this path, including the native left, top, bottom, and right edge classification. The broker keeps one DTUHID connection alive per simulator and arbitrates gestures across Codevisor processes, so simultaneous sessions cannot interleave touches. It never activates Device Hub, moves the Mac cursor, requires Accessibility permission, or needs a visible simulator window. Browser requests stay relative to the pane URL, so Codevisor proxies video and input through the same authenticated connection as the rest of the workspace.

## Development

```sh
bash scripts/install.sh
bun test
codevisor plugin link "$PWD"
```

The `.repos` submodules are optional references for development. Installation and runtime do not read them and do not require Git.

Open **iOS Simulator** from Codevisor's New Tab page. Selecting a shut-down device boots it automatically. Click inside the simulated screen to send pointer and keyboard input.

Requirements: macOS on Apple Silicon, Xcode Command Line Tools, Node.js 20 or newer, Bun, Homebrew, and an installed iOS Simulator runtime. The install script installs AXe's simulator frameworks when needed and builds the native DTUHID broker locally. Cursor-free input does not require macOS Accessibility permission.
