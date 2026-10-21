import { processPage, type PageJob } from './pixels';

// Typed as a Worker to avoid pulling the "webworker" lib into the whole (DOM) project.
const ctx = self as unknown as Worker;
ctx.onmessage = (e: MessageEvent<{ id: number; job: PageJob }>) => {
  const out = processPage(e.data.job);
  ctx.postMessage({ id: e.data.id, ...out }, [out.data.buffer]);
};
