# edk2-webflash

> This fork is no longer maintained. Roxora's web flasher is now the web
> version of Roxora Imager: https://roxora-os.github.io/imager/ (source:
> https://github.com/roxora-os/imager). The original flasher is
> https://github.com/gahingwoo/edk2-webflash.

WebUSB flasher for [edk2-rk3576](https://github.com/gahingwoo/edk2-rk3576) UEFI on Rockchip RK3576.
Runs entirely in the browser — no app, no driver, no USB passthrough.
Wraps [rkdeveloptool](https://github.com/rockchip-linux/rkdeveloptool) compiled to WASM via Emscripten.

**Live: https://flash.gahingwoo.com/**

> This is the Roxora Project's fork, deployed at
> https://roxora-os.github.io/edk2-webflash/. It adds a panel listing Roxora
> images. The original is
> [gahingwoo/edk2-webflash](https://github.com/gahingwoo/edk2-webflash), which
> serves flash.gahingwoo.com; this fork does not.

Requires Chrome or Edge (WebUSB). No drivers on Linux / macOS.
Windows: install WinUSB for the device via [Zadig](https://zadig.akeo.ie/).

---

## Usage

1. Pick the board: **ROCK 4D** or **CM5 IO**
2. Hold the **MaskROM button**, plug in USB-C, release
3. Click **Flash UEFI** → pick the Rockchip device from the browser prompt
4. Loader uploads, board reboots → click **Reconnect Device** → pick device again
5. Firmware flashes, board reboots into UEFI

| Board | Written to | Image |
|---|---|---|
| ROCK 4D | SPI NOR | `ROCK4D-spi-edk2-<ver>.img` from the latest edk2-rk3576 release |
| CM5 IO | eMMC | `CM5IO-emmc-edk2-<ver>.img` from the latest edk2-rk3576 release |

**Flash U-Boot** writes mainline U-Boot instead. **Flash Custom Image** writes
any image you pick from disk.

Custom images can be `.img`, `.img.xz` or `.img.gz`. Compressed files are
decompressed in the browser while they are written, so a multi-GB OS image
works without unpacking it first and without holding it in memory. Before
writing, the page reads the storage size and refuses an image that does not
fit; on the ROCK 4D, where it writes the 16 MiB SPI flash, it refuses OS-sized
images outright. After writing it can read back the first 32 MiB (partition
table and bootloader) and compare. It does not read back further: with the
RK3576 loader, reads past 32 MiB of the eMMC have returned 0xCC filler instead
of data.

> **Why two device picks?**
> After `DownloadBoot` the SoC resets and re-enumerates. WebUSB invalidates
> the old handle on disconnect, and `requestDevice()` requires a user gesture
> — it cannot be called from an async continuation. The button provides that gesture.

---

## How it works

```
index.html            UI + flash sequencer (main thread)
src/proxy.js          Promise-based Worker RPC wrapper
src/worker.js         Dedicated Worker — WASM host, WORKERFS mount manager
src/image-worker.js   Dedicated Worker: reads, decompresses and hashes custom images
src/image-proxy.js    Worker RPC wrapper for image-worker.js
src/image-source.js   format detection, decompression streams, wl-sized pieces
src/custom-flash.js   custom image write, rfi size check, read-back
src/xz.js, sha256.js  xz decoder (on vendor/xzwasm) and incremental SHA-256
vendor/xzwasm/        xz-embedded compiled to WebAssembly (xzwasm, MIT)
tests/                Node tests, with a stand-in for the rkdeveloptool worker
dist/                 CI-built artefacts (not in tree)
  rkdeveloptool.js    Emscripten glue
  rkdeveloptool.wasm
rock4d-spi-edk2.img   CI-bundled from the latest edk2-rk3576 release (not in tree)
cm5io-emmc-edk2.img
edk2-version.txt      which release was bundled; shown on the page
coi-serviceworker.js  Retrofits COOP/COEP for SharedArrayBuffer on static hosts
CMakeLists.wasm.txt   WASM build definition
```

Flash sequence (MaskROM path):

```
① Fetch rk3576_spl_loader.bin + the board's image in parallel, same origin
② requestDevice()  — user selects MaskROM-mode device
③ Await downloads, mount Blobs into WASM WORKERFS
④ rkdeveloptool db  — send SPL loader; SoC resets → Loader mode
⑤ User clicks Reconnect Device → requestDevice() → Loader-mode handle
⑥ rkdeveloptool wl 0  — stream the image: SPI NOR on ROCK 4D, eMMC on CM5 IO
⑦ rkdeveloptool rd  — reset
```

**Threading model:** rkdeveloptool is compiled with ASYNCIFY (no pthreads).
The WASM module runs in a Dedicated Worker for WORKERFS access.
`coi-serviceworker.js` enables `SharedArrayBuffer` so libusb can use
`Atomics.waitAsync` instead of a spin-poll, keeping ASYNCIFY fiber state intact.

---

## Building

Requires Emscripten 3.1.48 and CMake. See [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) for the exact steps. CI builds and deploys to GitHub Pages on every push to `main`, and daily.

The UEFI images are downloaded from the latest
[edk2-rk3576 release](https://github.com/gahingwoo/edk2-rk3576/releases/latest)
at deploy time, checked against its `SHA256SUMS.txt`, and served from this
site. The page cannot fetch them from GitHub directly: release downloads carry
no CORS headers. A new release therefore reaches the site on the next daily
run, or at once with a manual run of the workflow.

Tests need Node 22 and the `xz` and `gzip` commands, nothing else:

```
npm test
```

Custom image sequence (after ⑤):

```
rkdeveloptool rfi                   storage size; refuse an image that does not fit
.img:     rkdeveloptool wl 0 image   one call, WORKERFS reads the File as needed
.img.xz:  rkdeveloptool wl <lba> piece.img   one call per 32 MiB, decompressed in
          image-worker.js; a piece never starts with a sparse or UBI magic
rkdeveloptool rl 0 65536 readback   optional: compare the first 32 MiB
```

---

## License

GPL-2.0. See [LICENSE](LICENSE).

| Dependency | License |
|---|---|
| rkdeveloptool | GPL-2.0 |
| libusb 1.0.29 | LGPL-2.1 |
| coi-serviceworker | MIT |
| [xzwasm](https://github.com/SteveSanderson/xzwasm) (xz-embedded, walloc) | MIT (xz-embedded: public domain) |
| [edk2-rk3576](https://github.com/gahingwoo/edk2-rk3576) firmware | BSD-2-Clause-Patent |

