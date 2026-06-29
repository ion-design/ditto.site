import { gzipSync, deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

/** Build a single ustar tar header block (512 bytes) for a regular file. mtime is
 *  fixed at 0 so the archive is deterministic for the same inputs. */
function tarHeader(name: string, size: number): Buffer {
  let prefix = "";
  let nm = name;
  if (Buffer.byteLength(name) > 100) {
    let split = -1;
    for (let p = 0; p < name.length; p++) {
      if (name[p] === "/" && Buffer.byteLength(name.slice(p + 1)) <= 100 && Buffer.byteLength(name.slice(0, p)) <= 155) {
        split = p;
        break;
      }
    }
    if (split < 0) throw new Error("path too long for tar: " + name);
    prefix = name.slice(0, split);
    nm = name.slice(split + 1);
  }
  const h = Buffer.alloc(512);
  h.write(nm, 0, 100, "utf8");
  h.write("0000644\0", 100, 8, "ascii"); // mode
  h.write("0000000\0", 108, 8, "ascii"); // uid
  h.write("0000000\0", 116, 8, "ascii"); // gid
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii"); // size (octal)
  h.write("00000000000\0", 136, 12, "ascii"); // mtime = 0
  h.write("        ", 148, 8, "ascii"); // checksum placeholder (8 spaces)
  h.write("0", 156, 1, "ascii"); // typeflag: regular file
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  if (prefix) h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

/** Pack files into a deterministic .tar.gz (sorted by path, zero mtime). */
export function makeTarGz(files: Array<{ path: string; bytes: Buffer }>): Buffer {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts: Buffer[] = [];
  for (const f of sorted) {
    parts.push(tarHeader(f.path, f.bytes.length));
    parts.push(f.bytes);
    const pad = (512 - (f.bytes.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks = end of archive
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---- ZIP (deflate) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Pack files into a deterministic .zip (deflate; fixed DOS timestamp). */
export function makeZip(files: Array<{ path: string; bytes: Buffer }>): Buffer {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const DOS_TIME = 0; // fixed → deterministic
  const DOS_DATE = 0x21; // 1980-01-01
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of sorted) {
    const name = Buffer.from(f.path, "utf8");
    const crc = crc32(f.bytes);
    const comp = deflateRawSync(f.bytes, { level: 9 });
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(8, 8); // method: deflate
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.bytes.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(8, 10); // method
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.bytes.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk number
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += lh.length + name.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(local);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}
