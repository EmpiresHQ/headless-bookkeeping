/**
 * Compute CRC32 of a UTF-8 string.
 *
 * Returns an unsigned 32-bit integer suitable for fast comparison
 * and change detection of text artifacts.
 */
export function crc32(data: string): number {
  const bytes = Buffer.from(data, 'utf-8');
  const table = getCrc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ table[(crc & 0xff) ^ bytes[i]];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let crcTable: Uint32Array | undefined;

function getCrc32Table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}
