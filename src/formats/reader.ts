/** Cursor over a binary file. Sonic R PC data is LE; a few Saturn leftovers are BE. */
export class Reader {
  readonly v: DataView;
  o = 0;
  constructor(buf: ArrayBuffer | Uint8Array, readonly le = true) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  get size() { return this.v.byteLength; }
  get left() { return this.v.byteLength - this.o; }
  i32() { const x = this.v.getInt32(this.o, this.le); this.o += 4; return x; }
  u32() { const x = this.v.getUint32(this.o, this.le); this.o += 4; return x; }
  i16() { const x = this.v.getInt16(this.o, this.le); this.o += 2; return x; }
  u16() { const x = this.v.getUint16(this.o, this.le); this.o += 2; return x; }
  u8() { return this.v.getUint8(this.o++); }
  bytes(n: number) {
    const b = new Uint8Array(this.v.buffer, this.v.byteOffset + this.o, n).slice();
    this.o += n;
    return b;
  }
}
