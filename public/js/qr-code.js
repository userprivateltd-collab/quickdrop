/**
 * BeamDrop Compact Offline QR Code Generator
 * Pure JavaScript, zero dependencies. Generates QR codes directly onto HTML5 Canvas.
 * Supports Byte mode (ISO/IEC 18004) for LAN URLs.
 */

// QR Code Polynomials and Galois Field tables
const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);

(function initGaloisField() {
  let val = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = val;
    GF256_EXP[i + 255] = val;
    GF256_LOG[val] = i;
    val = (val << 1) ^ (val & 128 ? 0x11d : 0);
  }
})();

function gfMul(x, y) {
  if (x === 0 || y === 0) return 0;
  return GF256_EXP[GF256_LOG[x] + GF256_LOG[y]];
}

function polyMul(p1, p2) {
  const result = new Uint8Array(p1.length + p2.length - 1);
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) {
      result[i + j] ^= gfMul(p1[i], p2[j]);
    }
  }
  return result;
}

function polyRest(dividend, divisor) {
  const result = new Uint8Array(dividend);
  for (let i = 0; i <= dividend.length - divisor.length; i++) {
    const coef = result[i];
    if (coef !== 0) {
      for (let j = 0; j < divisor.length; j++) {
        result[i + j] ^= gfMul(divisor[j], coef);
      }
    }
  }
  return result.slice(dividend.length - divisor.length + 1);
}

function getGeneratorPoly(numEc) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < numEc; i++) {
    poly = polyMul(poly, new Uint8Array([1, GF256_EXP[i]]));
  }
  return poly;
}

// Version capacities (Error Correction Level L - Byte Mode)
// Version 3: 29x29 matrix, 55 total bytes (44 data, 15 ECC)
// Version 4: 33x33 matrix, 80 total bytes (64 data, 18 ECC)
// Version 5: 37x37 matrix, 108 total bytes (86 data, 26 ECC)
function pickVersion(dataLen) {
  if (dataLen <= 32) return { version: 3, size: 29, dataCap: 44, numEc: 15 };
  if (dataLen <= 52) return { version: 4, size: 33, dataCap: 64, numEc: 18 };
  return { version: 5, size: 37, dataCap: 86, numEc: 26 };
}

/**
 * Draw QR Code directly to canvas
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 */
export function drawQRCode(canvas, text) {
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(text);
  const cfg = pickVersion(dataBytes.length);
  const matrixSize = cfg.size;

  // Initialize empty matrix (-1 = unset, 0 = white, 1 = black)
  const matrix = Array.from({ length: matrixSize }, () => new Int8Array(matrixSize).fill(-1));
  const isFunction = Array.from({ length: matrixSize }, () => new Uint8Array(matrixSize));

  function setModule(r, c, val, func = false) {
    matrix[r][c] = val ? 1 : 0;
    if (func) isFunction[r][c] = 1;
  }

  // 1. Finder patterns (top-left, top-right, bottom-left)
  function drawFinderPattern(row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const mr = row + r;
        const mc = col + c;
        if (mr >= 0 && mr < matrixSize && mc >= 0 && mc < matrixSize) {
          if (r === -1 || r === 7 || c === -1 || c === 7) {
            setModule(mr, mc, 0, true);
          } else if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
            setModule(mr, mc, 1, true);
          } else {
            setModule(mr, mc, 0, true);
          }
        }
      }
    }
  }

  drawFinderPattern(0, 0);
  drawFinderPattern(0, matrixSize - 7);
  drawFinderPattern(matrixSize - 7, 0);

  // 2. Timing patterns
  for (let i = 8; i < matrixSize - 8; i++) {
    const val = i % 2 === 0 ? 1 : 0;
    if (matrix[6][i] === -1) setModule(6, i, val, true);
    if (matrix[i][6] === -1) setModule(i, 6, val, true);
  }

  // 3. Dark module
  setModule(matrixSize - 8, 8, 1, true);

  // 4. Alignment pattern for Version 3, 4, 5
  const alignCoords = cfg.version === 3 ? [6, 22] : cfg.version === 4 ? [6, 26] : [6, 30];
  const ar = alignCoords[1];
  const ac = alignCoords[1];
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const isBlack = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      setModule(ar + r, ac + c, isBlack ? 1 : 0, true);
    }
  }

  // 5. Reserve format information areas
  for (let i = 0; i < 9; i++) {
    if (matrix[8][i] === -1) setModule(8, i, 0, true);
    if (matrix[i][8] === -1) setModule(i, 8, 0, true);
  }
  for (let i = 0; i < 8; i++) {
    if (matrix[8][matrixSize - 1 - i] === -1) setModule(8, matrixSize - 1 - i, 0, true);
    if (matrix[matrixSize - 1 - i][8] === -1) setModule(matrixSize - 1 - i, 8, 0, true);
  }

  // 6. Encode data stream (Byte Mode: 0100 + 8-bit length + data + terminator)
  const bitStream = [];
  function pushBits(val, numBits) {
    for (let i = numBits - 1; i >= 0; i--) {
      bitStream.push((val >> i) & 1);
    }
  }

  pushBits(0b0100, 4); // Byte mode indicator
  pushBits(dataBytes.length, 8); // Character count indicator
  for (const b of dataBytes) {
    pushBits(b, 8);
  }
  // Terminator
  for (let i = 0; i < 4 && bitStream.length < cfg.dataCap * 8; i++) {
    bitStream.push(0);
  }
  // Pad to multiple of 8
  while (bitStream.length % 8 !== 0) {
    bitStream.push(0);
  }

  // Pad bytes (0xEC, 0x11)
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bitStream.length < cfg.dataCap * 8) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert bits to data words
  const dataWords = new Uint8Array(cfg.dataCap);
  for (let i = 0; i < cfg.dataCap; i++) {
    let word = 0;
    for (let b = 0; b < 8; b++) {
      word = (word << 1) | bitStream[i * 8 + b];
    }
    dataWords[i] = word;
  }

  // 7. Error correction calculation (Reed-Solomon)
  const genPoly = getGeneratorPoly(cfg.numEc);
  const dividend = new Uint8Array(cfg.dataCap + cfg.numEc);
  dividend.set(dataWords, 0);
  const eccWords = polyRest(dividend, genPoly);

  // Combine data + ECC
  const allCodewords = new Uint8Array(cfg.dataCap + cfg.numEc);
  allCodewords.set(dataWords, 0);
  allCodewords.set(eccWords, cfg.dataCap);

  // 8. Place data bits in matrix (Right-to-left 2-column zigzag)
  let bitIndex = 0;
  const totalBits = allCodewords.length * 8;
  let upwards = true;

  for (let c = matrixSize - 1; c > 0; c -= 2) {
    if (c === 6) c--; // Skip vertical timing line
    const rows = upwards ? Array.from({ length: matrixSize }, (_, i) => matrixSize - 1 - i) : Array.from({ length: matrixSize }, (_, i) => i);

    for (const r of rows) {
      for (const colOffset of [0, 1]) {
        const curCol = c - colOffset;
        if (!isFunction[r][curCol]) {
          let bit = 0;
          if (bitIndex < totalBits) {
            const bytePos = Math.floor(bitIndex / 8);
            const bitPos = 7 - (bitIndex % 8);
            bit = (allCodewords[bytePos] >> bitPos) & 1;
            bitIndex++;
          }
          // Mask 0: (row + col) % 2 === 0
          const maskedBit = ((r + curCol) % 2 === 0) ? (bit ^ 1) : bit;
          setModule(r, curCol, maskedBit);
        }
      }
    }
    upwards = !upwards;
  }

  // 9. Format Info (Mask 0, Level L: 0b111011111000100)
  const formatInfo = 0b111011111000100;
  for (let i = 0; i < 15; i++) {
    const bit = (formatInfo >> i) & 1;
    // Around top-left
    if (i <= 5) setModule(8, i, bit, true);
    else if (i === 6) setModule(8, 7, bit, true);
    else if (i === 7) setModule(8, 8, bit, true);
    else if (i === 8) setModule(7, 8, bit, true);
    else setModule(14 - i, 8, bit, true);

    // Around top-right and bottom-left
    if (i < 8) {
      setModule(matrixSize - 1 - i, 8, bit, true);
    } else {
      setModule(8, matrixSize - 15 + i, bit, true);
    }
  }

  // 10. Render to Canvas with Quiet Zone
  const ctx = canvas.getContext('2d');
  const quietZone = 4;
  const fullSize = matrixSize + quietZone * 2;
  const cellSize = Math.floor(canvas.width / fullSize);
  const offset = Math.floor((canvas.width - fullSize * cellSize) / 2);

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#111827';
  for (let r = 0; r < matrixSize; r++) {
    for (let c = 0; c < matrixSize; c++) {
      if (matrix[r][c] === 1) {
        ctx.fillRect(
          offset + (c + quietZone) * cellSize,
          offset + (r + quietZone) * cellSize,
          cellSize,
          cellSize
        );
      }
    }
  }
}
