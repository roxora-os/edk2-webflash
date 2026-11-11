/**
 * Main-thread side of image-worker.js: one promise per call, plus progress
 * events.
 */
export function createImageWorker({ workerUrl, onProgress }) {
  const worker = new Worker(workerUrl, { type: 'module' });
  let seq = 0;
  const pending = new Map();

  worker.addEventListener('message', ({ data: msg }) => {
    const { id, type, data } = msg;
    if (id == null) {
      if (type === 'progress') onProgress?.(data);
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data);
  });

  worker.addEventListener('error', (err) => {
    const e = new Error('Image worker crashed: ' + (err.message ?? String(err)));
    for (const [, p] of pending) p.reject(e);
    pending.clear();
  });

  function send(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, params });
    });
  }

  return {
    open:   (file)      => send('open', { file }),
    hash:   ()          => send('hash'),
    start:  (chunkSize) => send('start', { chunkSize }),
    next:   ()          => send('next'),
    cancel: ()          => send('cancel'),
    terminate: ()       => worker.terminate(),
  };
}
