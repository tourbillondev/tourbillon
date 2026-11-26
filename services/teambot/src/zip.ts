/// A one-file zip, stored without compression (a PNG is already compressed, and storing keeps the poster byte for
/// byte). Telegram recompresses photos; the zip sent beside each poster carries the full-quality file. No dependency:
/// the format is the local header, the data, one central directory entry and the end record (PKWARE APPNOTE 4.3).

const dosTime = (d: Date) => ((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2)) & 0xffff;
const dosDate = (d: Date) => (((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()) & 0xffff;

export function storedZip(name: string, data: Uint8Array, at = new Date()): Uint8Array {
  if (!/^[\w.-]{1,100}$/.test(name)) throw new Error(`zip: a plain file name is needed, not "${name}"`);
  if (data.length >= 0xffffffff) throw new Error("zip: the file is too large");
  const fname = new TextEncoder().encode(name);
  const crc = Bun.hash.crc32(data);
  const t = dosTime(at);
  const dt = dosDate(at);
  const local = new Uint8Array(30 + fname.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); // local file header
  lv.setUint16(4, 20, true); // version needed: 2.0
  lv.setUint16(6, 0, true); // flags
  lv.setUint16(8, 0, true); // method: stored
  lv.setUint16(10, t, true);
  lv.setUint16(12, dt, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, data.length, true); // compressed size
  lv.setUint32(22, data.length, true); // size
  lv.setUint16(26, fname.length, true);
  lv.setUint16(28, 0, true);
  local.set(fname, 30);
  const central = new Uint8Array(46 + fname.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); // central directory header
  cv.setUint16(4, 20, true); // made by
  cv.setUint16(6, 20, true); // version needed
  cv.setUint16(8, 0, true);
  cv.setUint16(10, 0, true);
  cv.setUint16(12, t, true);
  cv.setUint16(14, dt, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, fname.length, true);
  cv.setUint32(42, 0, true); // offset of the local header
  central.set(fname, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(8, 1, true); // entries on this disk
  ev.setUint16(10, 1, true); // entries
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + data.length, true); // where the central directory starts
  const out = new Uint8Array(local.length + data.length + central.length + end.length);
  out.set(local, 0);
  out.set(data, local.length);
  out.set(central, local.length + data.length);
  out.set(end, local.length + data.length + central.length);
  return out;
}

/// The names the staff see: project-update-07-square.zip, holding only project-update-07-square.png.
export const posterName = (n: number, which: "square" | "wide") => `project-update-${String(n).padStart(2, "0")}-${which}`;
export const zipName = (n: number, which: "square" | "wide") => `${posterName(n, which)}.zip`;
