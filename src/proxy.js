/**
 * Main-thread proxy for the rkdeveloptool Worker.
 *
 * Wraps the Worker's postMessage API into a promise-based interface.
 * The Worker must run in a cross-origin-isolated context (provided by
 * coi-serviceworker.js) so that SharedArrayBuffer is available for
 * proper ASYNCIFY + libusb WebUSB operation.
 */
export async function createFlashWorker({ workerUrl, moduleUrl, wasmUrl, onStdout, onStderr }) {
  const worker = new Worker(workerUrl, { type: 'module' });
  let seq = 0;
  const pending = new Map();

  worker.addEventListener('message', ({ data: msg }) => {
    const { id, type, data } = msg;

    // id === null → unsolicited output event (stdout/stderr)
    if (id == null) {
      if (type === 'stdout') onStdout?.(data.text);
      else if (type === 'stderr') onStderr?.(data.text);
      return;
    }

    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data);
  });

  worker.addEventListener('error', (err) => {
    const e = new Error('Worker crashed: ' + (err.message ?? String(err)));
    for (const [, p] of pending) p.reject(e);
    pending.clear();
  });

  function send(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // Blobs are structured-cloneable and can be sent via postMessage without
      // being transferred (they remain accessible in the main thread too).
      worker.postMessage({ id, method, params });
    });
  }

  // Initialize the WASM module inside the Worker before returning.
  await send('init', { moduleUrl, wasmUrl });

  return {
    /** Mount a Blob into WASM WORKERFS. Returns { dir, path }. */
    mountBlob: (name, blob)    => send('mountBlob', { name, blob }),
    /** Unmount a previously mounted directory. */
    umount:    ({ dir })       => send('umount', { dir }),
    /** Run rkdeveloptool with the given CLI args. Returns { exitCode }. */
    run:       (args)          => send('run', { args }),
    /** Read a file from the WASM filesystem. Returns a Uint8Array. */
    readFile:  (path)          => send('readFile', { path }),
    /** Delete a file from the WASM filesystem (no error if it is missing). */
    unlink:    (path)          => send('unlink', { path }),
    /** Sleep for ms milliseconds inside the Worker. */
    sleep:     (ms)            => send('sleep', { ms }),
    /** Terminate the Worker (cleanup). */
    terminate: ()              => worker.terminate(),
  };
}
