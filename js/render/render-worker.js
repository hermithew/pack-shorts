// Module worker that runs the render pipeline off the main thread (used by renderShort in render.js).
// Messages in:  {type:'render', file, events, settings} | {type:'abort'}
// Messages out: {type:'ready'} | {type:'progress', progress} | {type:'done', result} | {type:'error', name, message}
import { renderShortHere } from './render.js';

let ctrl = null;
self.onmessage = async ({ data }) => {
  if (data?.type === 'abort') { ctrl?.abort(new DOMException('Render cancelled', 'AbortError')); return; }
  if (data?.type !== 'render') return;
  ctrl = new AbortController();
  try {
    const result = await renderShortHere(data.file, data.events, data.settings, {
      signal: ctrl.signal,
      onProgress: progress => self.postMessage({ type: 'progress', progress }),
    });
    self.postMessage({ type: 'done', result });
  } catch (e) {
    self.postMessage({ type: 'error', name: e?.name || 'Error', message: e?.message || String(e) });
  }
};
self.postMessage({ type: 'ready' });
