import { inflateRawSync } from "node:zlib";

/**
 * dotLottie (.lottie) extraction.
 *
 * A `.lottie` file is NOT bare lottie-web JSON — it is a ZIP archive (the "dotLottie"
 * container) holding `manifest.json` plus one or more `animations/*.json` documents. Feeding
 * the raw ZIP bytes to lottie-web via `path:` makes it try to JSON.parse a ZIP, which throws
 * an InvalidStateError at runtime and leaves the container blank. So at materialization time
 * we detect the ZIP, pick the default/first animation, and rewrite the stored asset as plain
 * lottie JSON that lottie-web can parse directly.
 *
 * Node ships `zlib` (raw DEFLATE) but no ZIP reader, and pulling a zip dependency for this
 * one shape is overkill — so this implements the minimal slice of the ZIP spec needed:
 * walking the End-Of-Central-Directory + central directory to locate entries, then reading
 * each local file header to decompress a stored (method 0) or deflated (method 8) entry.
 * Deterministic: no timestamps, no randomness, entries resolved by name.
 */

/** ZIP local file header signature (`PK\x03\x04`). dotLottie archives always start with it. */
export function isZipArchive(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CEN_SIG = 0x02014b50; // Central directory file header
const LOC_SIG = 0x04034b50; // Local file header

type ZipEntry = { name: string; method: number; compSize: number; uncompSize: number; localOffset: number };

/** Locate + read the End-Of-Central-Directory record, then walk the central directory. */
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  // The EOCD lives at the tail; it is >=22 bytes and may carry a trailing comment, so scan
  // backwards for its signature within the max comment window (64KiB) + record size.
  const minEocd = 22;
  if (buf.length < minEocd) return [];
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - (0xffff + minEocd));
  for (let i = buf.length - minEocd; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return [];

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one central-directory entry by reading its local header for the data offset. */
function readEntry(buf: Buffer, e: ZipEntry): Buffer | null {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) return null;
  // The central directory's name/extra lengths can differ from the local header's, so read the
  // local header's own lengths to find where the file data begins.
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const dataEnd = dataStart + e.compSize;
  if (dataEnd > buf.length) return null;
  const comp = buf.subarray(dataStart, dataEnd);
  if (e.method === 0) return Buffer.from(comp); // stored
  if (e.method === 8) {
    try { return inflateRawSync(comp); } catch { return null; }
  }
  return null; // unsupported compression method
}

/** Read a named entry (exact path match) from a ZIP buffer, or null if absent/unreadable. */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const entry = readCentralDirectory(buf).find((e) => e.name === name);
  return entry ? readEntry(buf, entry) : null;
}

/**
 * Extract the lottie animation JSON from a dotLottie ZIP. Picks the manifest's first/default
 * animation (falling back to the first `animations/*.json` entry), returning it as a Buffer of
 * plain lottie JSON ready to hand to lottie-web via `path:`. Returns null when the bytes are
 * not a dotLottie ZIP or no animation JSON is present.
 */
export function extractDotLottieJson(bytes: Buffer): Buffer | null {
  if (!isZipArchive(bytes)) return null;
  const entries = readCentralDirectory(bytes);
  if (!entries.length) return null;

  const animEntries = entries
    .filter((e) => /^animations\/.+\.json$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name)); // deterministic ordering
  if (!animEntries.length) return null;

  // Prefer the animation the manifest names first (its default), when the manifest is readable.
  let chosen = animEntries[0]!;
  const manifestBuf = readZipEntry(bytes, "manifest.json");
  if (manifestBuf) {
    try {
      const manifest = JSON.parse(manifestBuf.toString("utf8")) as { animations?: Array<{ id?: string }> };
      const firstId = manifest.animations?.[0]?.id;
      if (firstId) {
        const match = animEntries.find((e) => e.name === `animations/${firstId}.json`);
        if (match) chosen = match;
      }
    } catch { /* manifest unreadable — keep the name-sorted first animation */ }
  }

  const json = readEntry(bytes, chosen);
  if (!json) return null;
  // Validate it parses as JSON (lottie-web's `path:` loader does a bare JSON.parse).
  try { JSON.parse(json.toString("utf8")); } catch { return null; }
  return json;
}
