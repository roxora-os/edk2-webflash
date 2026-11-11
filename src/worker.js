/**
 * rkdeveloptool Dedicated Worker
 *
 * Loads and runs the Emscripten-compiled rkdeveloptool WASM module.
 * Runs inside a Dedicated Worker so that WORKERFS (used for zero-copy Blob
 * access) is available, and so that SharedArrayBuffer (enabled by
 * coi-serviceworker.js) can be used by libusb's Atomics.waitAsync path.
 *
 * Filesystem setup mirrors jjm2473/rktool-webusb rkdeveloptool-wrapper.js:
 *   - MEMFS at /tmp  (rkdeveloptool writes logs and reads config.ini here)
 *   - /tmp/config.ini  (empty file to satisfy stat() check in main.cpp)
 *   - /tmp/log/        (directory for CRKLog)
 *   - cwd set to /tmp  (so szProgramDir = "." resolves to /tmp)
 *   - Binary blobs mounted via WORKERFS under /tmp/mounts/
 *
 * ASYNCIFY compatibility:
 *   callMain() may return a number, a Promise, or leave a fiber that resolves
 *   via Asyncify.whenDone(). We handle all three cases.
 */

let mod = null;
let mountSeq = 0;

function reply(id, data) {
  self.postMessage({ id, type: 'ok', data });
}

function fail(id, err) {
  self.postMessage({ id, type: 'error', data: { message: String(err?.message ?? err) } });
}

function emit(type, text) {
  self.postMessage({ id: null, type, data: { text } });
}

function ensureDir(FS, path) {
  try {
    FS.mkdir(path);
  } catch (e) {
    try { FS.stat(path); } catch (_) { throw e; }
  }
}

/**
 * Set up rkdeveloptool's expected VFS layout.
 * rkdeveloptool/main.cpp (Emscripten path) sets szProgramDir = "." and looks
 * for "./config.ini" and "./log/" relative to cwd.  We chdir to /tmp and
 * create both files there.
 */
function setupWasmFs(FS) {
  ensureDir(FS, '/tmp');
  try { FS.mount(FS.filesystems.MEMFS, {}, '/tmp'); } catch (_) {}
  ensureDir(FS, '/tmp/log');
  try { FS.writeFile('/tmp/config.ini', '', { encoding: 'utf8' }); } catch (_) {}
  ensureDir(FS, '/tmp/mounts');
  FS.chdir('/tmp');
}

async function callMain(args) {
  const result = mod.callMain(args.map(String));
  if (result && typeof result.then === 'function') return result;
  const asyncify = mod.Asyncify;
  if (asyncify?.currData && typeof asyncify.whenDone === 'function') {
    return asyncify.whenDone();
  }
  return result;
}

self.addEventListener('message', async ({ data: msg }) => {
  const { id, method, params } = msg;
  try {
    switch (method) {

      case 'init': {
        const { moduleUrl, wasmUrl } = params;
        const imported = await import(moduleUrl);
        const factory = imported.default ?? imported.createRKDevelopToolModule;
        if (typeof factory !== 'function') {
          throw new Error('WASM module factory not found in: ' + moduleUrl);
        }

        let lastProgressLine = '';
        function dedupedPrint(text) {
          if (!text) return;
          if (text.includes('Write LBA from file')) {
            if (text === lastProgressLine) return;
            lastProgressLine = text;
          }
          emit('stdout', text);
        }

        mod = await factory({
          noInitialRun: true,
          locateFile: (path) => path.endsWith('.wasm') ? wasmUrl : path,
          print:    dedupedPrint,
          printErr: (text) => { if (text) emit('stderr', text); },
        });

        setupWasmFs(mod.FS);
        reply(id, {});
        break;
      }

      case 'mountBlob': {
        if (!mod) throw new Error('Worker not initialized');
        const { name, blob } = params;
        const dir = `/tmp/mounts/${++mountSeq}`;
        ensureDir(mod.FS, dir);
        mod.FS.mount(mod.WORKERFS, { blobs: [{ name, data: blob }] }, dir);
        reply(id, { dir, path: `${dir}/${name}` });
        break;
      }

      case 'umount': {
        if (!mod) throw new Error('Worker not initialized');
        const { dir } = params;
        try { mod.FS.unmount(dir); } catch (_) {}
        try { mod.FS.rmdir(dir);   } catch (_) {}
        reply(id, {});
        break;
      }

      case 'run': {
        if (!mod) throw new Error('Worker not initialized');
        const exitCode = Number((await callMain(params.args)) ?? 0);
        reply(id, { exitCode });
        break;
      }

      case 'readFile': {
        if (!mod) throw new Error('Worker not initialized');
        const data = mod.FS.readFile(params.path);
        self.postMessage({ id, type: 'ok', data }, [data.buffer]);
        break;
      }

      case 'unlink': {
        if (!mod) throw new Error('Worker not initialized');
        try { mod.FS.unlink(params.path); } catch (_) {}
        reply(id, {});
        break;
      }

      case 'sleep': {
        await new Promise((ok) => setTimeout(ok, params.ms));
        reply(id, {});
        break;
      }

      default:
        throw new Error('Unknown worker method: ' + method);
    }
  } catch (err) {
    fail(id, err);
  }
});
