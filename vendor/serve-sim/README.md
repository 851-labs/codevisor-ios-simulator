# Vendored serve-sim runtime

This directory contains the runtime subset of
[`serve-sim`](https://github.com/EvanBacon/serve-sim) used by the plugin:

- `middleware.js` provides SimulatorKit framebuffer capture and legacy HID transport.
- `native/serve-sim-native.node` is the Apple-silicon native capture addon.
- `simax/serve-sim-ax-settings` changes accessibility and display settings inside the simulator.

The files come from commit `39958d059f39fa0080e910b8326a95cf159de33e`
and are distributed under the included Apache 2.0 license. They are checked in so
registry installs work from a source archive without Git or submodules. The
`.repos/serve-sim` checkout is only a development reference.
