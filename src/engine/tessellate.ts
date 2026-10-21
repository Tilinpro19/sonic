/**
 * Crack-free curved tessellation (PN triangles) for the low-poly 1998 geometry.
 *
 *  - Positions are welded globally, so neighbouring meshes share edges.
 *  - Corner normals average only faces within `creaseDeg` → buildings and hard edges stay sharp.
 *  - Each edge's Bézier control points are computed once, from the edge's own endpoint normals
 *    (averaged over the two faces that share it) and always in the same direction, so both
 *    triangles on an edge produce bit-identical points: no cracks.
 *  - Border edges and creases stay straight; triangles that are already flat are emitted as is.
 * UVs and colours are interpolated linearly, so the original texturing and baked lighting are kept.
 */

export interface Soup {
  /** Per triangle: 9 position floats, 6 uv, 9 colour, 1 group id. */
  pos: number[];
  uv: number[];
  col: number[];
  group: number[];
}

export interface OutBuffers { pos: number[]; nrm: number[]; uv: number[]; col: number[] }

type V3 = [number, number, number];
export interface OutArrays { pos: Float32Array; nrm: Float32Array; uv: Float32Array; col: Float32Array }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};

export function tessellate(s: Soup, level: number, creaseDeg = 50): Map<number, OutBuffers> {
  const n = s.group.length;
  const cosT = Math.cos((creaseDeg * Math.PI) / 180);
  const P = (f: number, c: number): V3 => [s.pos[f * 9 + c * 3], s.pos[f * 9 + c * 3 + 1], s.pos[f * 9 + c * 3 + 2]];

  // ---- weld ----
  // Numeric weld key: coordinates rounded to ¼ unit, 17 bits each (world spans ±20 000 units).
  const idOf = new Map<number, number>();
  const ids = new Int32Array(n * 3);
  const q = (v: number) => Math.round(v * 2) + 65536;
  for (let f = 0; f < n; f++)
    for (let c = 0; c < 3; c++) {
      const o = f * 9 + c * 3;
      const k = (q(s.pos[o]) * 131072 + q(s.pos[o + 1])) * 131072 + q(s.pos[o + 2]);
      let id = idOf.get(k);
      if (id === undefined) idOf.set(k, (id = idOf.size));
      ids[f * 3 + c] = id;
    }

  // ---- face normals + vertex → faces ----
  const fn: V3[] = [], area = new Float64Array(n);
  const adj: number[][] = Array.from({ length: idOf.size }, () => []);
  for (let f = 0; f < n; f++) {
    const a = P(f, 0), e1 = sub(P(f, 1), a), e2 = sub(P(f, 2), a);
    const c: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    area[f] = Math.hypot(c[0], c[1], c[2]) / 2;
    fn.push(norm(c));
    for (let k = 0; k < 3; k++) adj[ids[f * 3 + k]].push(f);
  }

  // ---- crease-aware corner normals ----
  const cn: V3[] = new Array(n * 3);
  for (let f = 0; f < n; f++)
    for (let c = 0; c < 3; c++) {
      let x = 0, y = 0, z = 0;
      for (const g of adj[ids[f * 3 + c]]) {
        if (dot(fn[f], fn[g]) < cosT) continue;
        x += fn[g][0] * area[g]; y += fn[g][1] * area[g]; z += fn[g][2] * area[g];
      }
      cn[f * 3 + c] = area[f] > 0 ? norm([x, y, z]) : fn[f];
    }

  // ---- edges ----
  const ekey = (a: number, b: number) => (a < b ? a * 1048576 + b : b * 1048576 + a);
  const edgeFaces = new Map<number, number[]>();
  for (let f = 0; f < n; f++)
    for (let c = 0; c < 3; c++) {
      const k = ekey(ids[f * 3 + c], ids[f * 3 + ((c + 1) % 3)]);
      const l = edgeFaces.get(k);
      if (l) l.push(f); else edgeFaces.set(k, [f]);
    }
  const cornerOf = (f: number, id: number) => (ids[f * 3] === id ? 0 : ids[f * 3 + 1] === id ? 1 : 2);

  interface Edge { smooth: boolean; pa: V3; ca: V3; cb: V3; pb: V3; na: V3; nb: V3 } // canonical a < b
  const edgeCache = new Map<number, Edge>();
  const edgeOf = (f: number, c0: number, c1: number): Edge => {
    let a = ids[f * 3 + c0], b = ids[f * 3 + c1];
    let ia = c0, ib = c1;
    if (a > b) { [a, b] = [b, a]; [ia, ib] = [ib, ia]; }
    const k = ekey(a, b);
    let e = edgeCache.get(k);
    if (e) return e;
    const pa = P(f, ia), pb = P(f, ib);
    const faces = edgeFaces.get(k)!;
    const g = faces.length === 2 ? (faces[0] === f ? faces[1] : faces[0]) : -1;
    const smooth = g >= 0 && dot(fn[f], fn[g]) >= cosT && area[f] > 0 && area[g] > 0;
    let na = cn[f * 3 + ia], nb = cn[f * 3 + ib];
    if (smooth) {
      const ga = cn[g * 3 + cornerOf(g, a)], gb = cn[g * 3 + cornerOf(g, b)];
      na = norm([na[0] + ga[0], na[1] + ga[1], na[2] + ga[2]]);
      nb = norm([nb[0] + gb[0], nb[1] + gb[1], nb[2] + gb[2]]);
    }
    const third = (p: V3, q: V3, nn: V3 | null): V3 => {
      const w = nn ? dot(sub(q, p), nn) : 0;
      return [(2 * p[0] + q[0] - w * (nn?.[0] ?? 0)) / 3, (2 * p[1] + q[1] - w * (nn?.[1] ?? 0)) / 3, (2 * p[2] + q[2] - w * (nn?.[2] ?? 0)) / 3];
    };
    e = { smooth, pa, pb, na, nb, ca: third(pa, pb, smooth ? na : null), cb: third(pb, pa, smooth ? nb : null) };
    edgeCache.set(k, e);
    return e;
  };
  const bez = (e: Edge, t: number): V3 => {
    const s1 = 1 - t, a = s1 * s1 * s1, b = 3 * s1 * s1 * t, c = 3 * s1 * t * t, d = t * t * t;
    return [
      a * e.pa[0] + b * e.ca[0] + c * e.cb[0] + d * e.pb[0],
      a * e.pa[1] + b * e.ca[1] + c * e.cb[1] + d * e.pb[1],
      a * e.pa[2] + b * e.ca[2] + c * e.cb[2] + d * e.pb[2],
    ];
  };

  // ---- emit ----
  const out = new Map<number, OutBuffers>();
  const buf = (g: number) => {
    let o = out.get(g);
    if (!o) out.set(g, (o = { pos: [], nrm: [], uv: [], col: [] }));
    return o;
  };

  for (let f = 0; f < n; f++) {
    const o = buf(s.group[f]);
    const p = [P(f, 0), P(f, 1), P(f, 2)];
    const uv = s.uv.slice(f * 6, f * 6 + 6), col = s.col.slice(f * 9, f * 9 + 9);
    const nn = [cn[f * 3], cn[f * 3 + 1], cn[f * 3 + 2]];
    const E = [edgeOf(f, 0, 1), edgeOf(f, 1, 2), edgeOf(f, 2, 0)];
    const flatN = (x: V3) => dot(x, fn[f]) > 0.9995;
    const flat = level <= 1 || (nn.every(flatN) && E.every((e) => !e.smooth || (flatN(e.na) && flatN(e.nb))));
    const L = flat ? 1 : level;

    // Control net (b_ijk ↔ u^i v^j w^k with u→P0, v→P1, w→P2), oriented for this face.
    const fromIsA = (from: number) => ids[f * 3 + from] < ids[f * 3 + ((from + 1) % 3)];
    const ctrl = (e: Edge, from: number): [V3, V3] => (fromIsA(from) ? [e.ca, e.cb] : [e.cb, e.ca]);
    const [b210, b120] = ctrl(E[0], 0), [b021, b012] = ctrl(E[1], 1), [b102, b201] = ctrl(E[2], 2);
    const Eavg = [0, 1, 2].map((i) => (b210[i] + b120[i] + b021[i] + b012[i] + b102[i] + b201[i]) / 6);
    const Vavg = [0, 1, 2].map((i) => (p[0][i] + p[1][i] + p[2][i]) / 3);
    const b111 = [0, 1, 2].map((i) => Eavg[i] + (Eavg[i] - Vavg[i]) / 2);

    // Integer barycentrics (i + j + k = L) so both faces of an edge evaluate the exact same t.
    const onEdge = (ei: number, from: number, k: number) => bez(E[ei], fromIsA(from) ? k / L : (L - k) / L);
    const point = (i: number, j: number, k: number): V3 => {
      if (i === L) return p[0];
      if (j === L) return p[1];
      if (k === L) return p[2];
      if (k === 0) return onEdge(0, 0, j);
      if (i === 0) return onEdge(1, 1, k);
      if (j === 0) return onEdge(2, 2, i);
      const u = i / L, v = j / L, w = k / L;
      const r: V3 = [0, 0, 0];
      for (let a = 0; a < 3; a++)
        r[a] = u * u * u * p[0][a] + v * v * v * p[1][a] + w * w * w * p[2][a]
          + 3 * u * u * v * b210[a] + 3 * u * v * v * b120[a] + 3 * v * v * w * b021[a] + 3 * v * w * w * b012[a]
          + 3 * w * w * u * b102[a] + 3 * w * u * u * b201[a] + 6 * u * v * w * b111[a];
      return r;
    };
    const emit = (i: number, j: number, k: number) => {
      const q = point(i, j, k);
      const u = i / L, v = j / L, w = k / L;
      o.pos.push(q[0], q[1], q[2]);
      const nv = norm([
        u * nn[0][0] + v * nn[1][0] + w * nn[2][0],
        u * nn[0][1] + v * nn[1][1] + w * nn[2][1],
        u * nn[0][2] + v * nn[1][2] + w * nn[2][2],
      ]);
      o.nrm.push(nv[0], nv[1], nv[2]);
      o.uv.push(u * uv[0] + v * uv[2] + w * uv[4], u * uv[1] + v * uv[3] + w * uv[5]);
      for (let i = 0; i < 3; i++) o.col.push(u * col[i] + v * col[3 + i] + w * col[6 + i]);
    };
    // Row r, column c: (i, j, k) = (L−r, r−c, c). Same winding as (P0, P1, P2).
    const at = (r: number, c: number) => emit(L - r, r - c, c);
    for (let r = 0; r < L; r++)
      for (let c = 0; c <= r; c++) {
        at(r, c); at(r + 1, c); at(r + 1, c + 1);
        if (c < r) { at(r, c); at(r + 1, c + 1); at(r, c + 1); }
      }
  }
  return out;
}
