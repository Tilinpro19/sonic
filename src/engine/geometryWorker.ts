import { tessellate, type Soup } from './tessellate';

const ctx = self as unknown as Worker;
ctx.onmessage = (e: MessageEvent<{ soup: { pos: Float64Array; uv: Float32Array; col: Float32Array; group: Int32Array }; level: number }>) => {
  const { soup, level } = e.data;
  const plain: Soup = { pos: Array.from(soup.pos), uv: Array.from(soup.uv), col: Array.from(soup.col), group: Array.from(soup.group) };
  const out = tessellate(plain, level);
  const groups = [...out].map(([g, b]) => ({
    g, pos: new Float32Array(b.pos), nrm: new Float32Array(b.nrm), uv: new Float32Array(b.uv), col: new Float32Array(b.col),
  }));
  ctx.postMessage(groups, groups.flatMap((x) => [x.pos.buffer, x.nrm.buffer, x.uv.buffer, x.col.buffer]));
};
