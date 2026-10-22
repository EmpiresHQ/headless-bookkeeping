// Deterministic, valid 1x1 RGB PNG, unique per synthetic document.
const { deflateSync } = require('node:zlib');
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type),
    size = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([size, t, data, crc]);
}
module.exports = function png(i) {
  const h = Buffer.alloc(13);
  h.writeUInt32BE(1, 0);
  h.writeUInt32BE(1, 4);
  h[8] = 8;
  h[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', h),
    chunk('IDAT', deflateSync(Buffer.from([0, i & 255, (i >>> 8) & 255, 128]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
