// Compact ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level L, Versions 1-8)
// for rendering scannable pairing QR codes in terminals with zero external deps.

interface VersionSpec {
  version: number;
  size: number;
  dataCodewords: number;
  ecPerBlock: number;
  blocks: readonly { count: number; data: number }[];
  align: readonly number[];
}

// Level L specifications for versions 1-8 (byte capacity up to 192 bytes).
const VERSIONS: readonly VersionSpec[] = [
  { version: 1, size: 21, dataCodewords: 19, ecPerBlock: 7, blocks: [{ count: 1, data: 19 }], align: [] },
  { version: 2, size: 25, dataCodewords: 34, ecPerBlock: 10, blocks: [{ count: 1, data: 34 }], align: [6, 18] },
  { version: 3, size: 29, dataCodewords: 55, ecPerBlock: 15, blocks: [{ count: 1, data: 55 }], align: [6, 22] },
  { version: 4, size: 33, dataCodewords: 80, ecPerBlock: 20, blocks: [{ count: 1, data: 80 }], align: [6, 26] },
  { version: 5, size: 37, dataCodewords: 108, ecPerBlock: 26, blocks: [{ count: 1, data: 108 }], align: [6, 30] },
  { version: 6, size: 41, dataCodewords: 136, ecPerBlock: 18, blocks: [{ count: 2, data: 68 }], align: [6, 34] },
  { version: 7, size: 45, dataCodewords: 156, ecPerBlock: 20, blocks: [{ count: 2, data: 78 }], align: [6, 22, 38] },
  { version: 8, size: 49, dataCodewords: 194, ecPerBlock: 24, blocks: [{ count: 2, data: 97 }], align: [6, 24, 42] }
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGenerator(degree: number): Uint8Array {
  let poly: Uint8Array = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const rem = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    for (let i = 0; i < ecCount; i++) rem[i] = rem[i]! ^ gfMul(gen[i + 1]!, factor);
  }
  return rem;
}

function bchFormat(ecBits: number, mask: number): number {
  const data = (ecBits << 3) | mask;
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function bchVersion(version: number): number {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) {
    if (rem & (1 << (i + 12))) rem ^= 0x1f25 << i;
  }
  return (version << 12) | rem;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = Buffer.from(text, 'utf8');
  // Byte mode: 4-bit mode (0100) + 8-bit length (versions 1-9) + payload + terminator.
  const spec = VERSIONS.find(v => v.dataCodewords * 8 >= 4 + 8 + bytes.length * 8);
  if (!spec) throw new Error('Text too long for terminal QR code');

  const bits: number[] = [];
  const pushBits = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  const capacityBits = spec.dataCodewords * 8;
  const term = Math.min(4, capacityBits - bits.length);
  pushBits(0, term);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(spec.dataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | bits[i * 8 + j]!;
    data[i] = val;
  }
  const padBytes = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < data.length; i++, p = 1 - p) data[i] = padBytes[p]!;

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const group of spec.blocks) {
    for (let i = 0; i < group.count; i++) {
      const slice = data.subarray(offset, offset + group.data);
      offset += group.data;
      dataBlocks.push(slice);
      ecBlocks.push(rsRemainder(slice, spec.ecPerBlock));
    }
  }

  const codewords: number[] = [];
  const maxDataLen = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) if (i < block.length) codewords.push(block[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) codewords.push(block[i]!);
  }

  const size = spec.size;
  const modules: boolean[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r]![c] = dark;
    reserved[r]![c] = true;
  };

  const drawFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const outer = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        const dark = !outer && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFunc(r0 + dr, c0 + dc, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (const r of spec.align) {
    for (const c of spec.align) {
      if (reserved[r]![c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunc(r + dr, c + dc, dark);
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Reserve format info strips + dark module.
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8]![i]) setFunc(8, i, false);
    if (!reserved[i]![8]) setFunc(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setFunc(8, size - 1 - i, false);
    if (i < 7) setFunc(size - 1 - i, 8, false);
  }
  setFunc(size - 8, 8, true);

  if (spec.version >= 7) {
    const vBits = bchVersion(spec.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3), b = size - 11 + (i % 3);
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  // Place data bits in zigzag column pairs.
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        if (reserved[r]![c]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          const byte = codewords[bitIndex >>> 3]!;
          dark = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        modules[r]![c] = dark;
      }
    }
    upward = !upward;
  }

  // Mask 0 ((r + c) % 2 === 0) with ECC Level L (ecBits = 01).
  const mask = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r]![c] && (r + c) % 2 === 0) modules[r]![c] = !modules[r]![c];
    }
  }

  const fmt = bchFormat(0b01, mask);
  const fBit = (i: number) => ((fmt >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) modules[8]![i] = fBit(14 - i);
  modules[8]![7] = fBit(8);
  modules[8]![8] = fBit(7);
  modules[7]![8] = fBit(6);
  for (let i = 0; i <= 5; i++) modules[5 - i]![8] = fBit(5 - i);
  for (let i = 0; i < 8; i++) modules[8]![size - 1 - i] = fBit(i);
  for (let i = 0; i < 7; i++) modules[size - 7 + i]![8] = fBit(14 - i);

  return modules;
}

/** Render a compact scannable QR code for terminal output using Unicode half-blocks. */
export function renderTerminalQr(text: string): string {
  const matrix = encodeQrMatrix(text);
  const quiet = 2;
  const n = matrix.length;
  const full = n + quiet * 2;
  const isDark = (r: number, c: number) => {
    const mr = r - quiet, mc = c - quiet;
    return mr >= 0 && mr < n && mc >= 0 && mc < n && matrix[mr]![mc] === true;
  };
  const lines: string[] = [];
  for (let r = 0; r < full; r += 2) {
    let line = '';
    for (let c = 0; c < full; c++) {
      // Invert for typical dark terminal background: white quiet zone = light blocks.
      const topLight = !isDark(r, c);
      const botLight = r + 1 < full ? !isDark(r + 1, c) : true;
      line += topLight && botLight ? '█' : topLight ? '▀' : botLight ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
