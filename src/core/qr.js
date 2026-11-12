/**
 * A small QR code encoder for the phone recorder's link (no dependency).
 *
 * Byte mode, error correction level M, versions 1 to 10: up to 213 bytes,
 * plenty for "https://<lan-ip>:<port>/?token=<48 hex>". Follows ISO/IEC 18004;
 * the layout steps mirror the well-known reference implementations.
 * tests/qr.test.js checks the Reed-Solomon codewords and the format/version
 * bits against the published vectors.
 */

// Level M, per version: [EC codewords per block, [blocks, data codewords]...]
const BLOCKS_M = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]]
];
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MAX_VERSION = 10;
const EC_LEVEL_M_BITS = 0b00;

// ── GF(256), polynomial 0x11D ──

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Generator polynomial for `degree` EC codewords, highest power first (leading 1 dropped). */
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1);
}

/** Reed-Solomon EC codewords for one block of data codewords. */
function rsRemainder(data, degree) {
  const gen = generator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i], factor);
  }
  return rem;
}

// ── Format and version information ──

function formatBits(mask) {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// ── Data ──

function dataCodewordCount(version) {
  return BLOCKS_M[version].slice(1).reduce((sum, [blocks, size]) => sum + blocks * size, 0);
}

function pickVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= dataCodewordCount(version) * 8) return version;
  }
  throw new Error(`Too long for a QR code: ${byteLength} bytes`);
}

/** Mode, length, bytes, terminator and padding, then EC, interleaved. */
function codewords(bytes, version) {
  const bits = [];
  const put = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCodewordCount(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

  const [ecPerBlock, ...groups] = BLOCKS_M[version];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let b = 0; b < count; b++) {
      const chunk = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, ecPerBlock) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const block of blocks) out.push(block.ec[i]);
  return out;
}

// ── Matrix ──

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  /** x = column, y = row. */
  setFixed(x, y, dark) {
    this.dark[y][x] = dark;
    this.fixed[y][x] = true;
  }

  drawPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFixed(6, i, i % 2 === 0);
      this.setFixed(i, 6, i % 2 === 0);
    }
    // Finders with their light separators.
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          this.setFixed(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    const positions = ALIGNMENT[this.version];
    const last = positions.length - 1;
    positions.forEach((cy, i) => {
      positions.forEach((cx, j) => {
        // Skip the three corners taken by finders.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.setFixed(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      });
    });
    this.drawFormat(0); // reserves the area; drawn for real once the mask is known
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.setFixed(a, b, dark);
        this.setFixed(b, a, dark);
      }
    }
  }

  drawFormat(mask) {
    const { size } = this;
    const bits = formatBits(mask);
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.setFixed(8, i, bit(i));
    this.setFixed(8, 7, bit(6));
    this.setFixed(8, 8, bit(7));
    this.setFixed(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFixed(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFixed(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFixed(8, size - 15 + i, bit(i));
    this.setFixed(8, size - 8, true); // the dark module
  }

  /** Zig-zag placement, two columns at a time from the bottom right. */
  drawCodewords(words) {
    const { size } = this;
    const total = words.length * 8;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing column
      const upward = ((right + 1) & 2) === 0;
      for (let step = 0; step < size; step++) {
        const y = upward ? size - 1 - step : step;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (this.fixed[y][x]) continue;
          // Remainder bits past the data stay light.
          this.dark[y][x] = i < total && ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  applyMask(mask) {
    const test = MASKS[mask];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) if (!this.fixed[y][x] && test(x, y)) this.dark[y][x] = !this.dark[y][x];
    }
  }

  penalty() {
    const { size, dark } = this;
    let score = 0;
    const line = (get) => {
      // Runs of five or more.
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // Finder-like 1:1:3:1:1 with four light modules on one side.
      for (let i = 0; i + 11 <= size; i++) {
        const seg = Array.from({ length: 11 }, (_, k) => get(i + k));
        const core = (o) => seg[o] && !seg[o + 1] && seg[o + 2] && seg[o + 3] && seg[o + 4] && !seg[o + 5] && seg[o + 6];
        if (core(0) && !seg[7] && !seg[8] && !seg[9] && !seg[10]) score += 40;
        if (!seg[0] && !seg[1] && !seg[2] && !seg[3] && core(4)) score += 40;
      }
    };
    for (let y = 0; y < size; y++) line((x) => dark[y][x]);
    for (let x = 0; x < size; x++) line((y) => dark[y][x]);
    let darkCount = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (dark[y][x]) darkCount++;
        if (x + 1 < size && y + 1 < size) {
          const c = dark[y][x];
          if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
        }
      }
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/**
 * @param {string} text
 * @returns {{ version: number, mask: number, size: number, modules: boolean[][] }}
 */
function encode(text, { mask: forcedMask } = {}) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = pickVersion(bytes.length);
  const words = codewords(bytes, version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forcedMask !== undefined && mask !== forcedMask) continue;
    const matrix = new Matrix(version);
    matrix.drawPatterns();
    matrix.drawCodewords(words);
    matrix.applyMask(mask);
    matrix.drawFormat(mask);
    const score = forcedMask !== undefined ? 0 : matrix.penalty();
    if (!best || score < best.score) best = { score, mask, matrix };
  }
  return { version, mask: best.mask, size: best.matrix.size, modules: best.matrix.dark };
}

/** Black on white whatever the page theme: scanners want dark modules on light. */
function toSvg(text, { margin = 4 } = {}) {
  const { size, modules } = encode(text);
  const full = size + margin * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y][x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">` +
    `<rect width="${full}" height="${full}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

module.exports = { encode, toSvg, rsRemainder, formatBits, versionBits, pickVersion, codewords };
