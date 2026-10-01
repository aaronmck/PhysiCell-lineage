/**
 * Reader for MATLAB level-4 ("-v4") .mat files, the format BioFVM/PhysiCell
 * writes for cells, meshes and the microenvironment.
 *
 * Layout: a 20-byte header of five uint32 (type, rows, cols, imagf, name length),
 * the NUL-terminated matrix name, then rows*cols numbers in column-major order.
 * The type word is MOPT: thousands = byte order, tens = numeric precision.
 */

const PRECISION = {
  0: { bytes: 8, read: (dv, o, le) => dv.getFloat64(o, le) },
  1: { bytes: 4, read: (dv, o, le) => dv.getFloat32(o, le) },
  2: { bytes: 4, read: (dv, o, le) => dv.getInt32(o, le) },
  3: { bytes: 2, read: (dv, o, le) => dv.getInt16(o, le) },
  4: { bytes: 2, read: (dv, o, le) => dv.getUint16(o, le) },
  5: { bytes: 1, read: (dv, o, le) => dv.getUint8(o) },
};

/**
 * @param {ArrayBuffer} buffer
 * @returns {{name: string, rows: number, cols: number, data: Float64Array}}
 *   `data` is column-major: element (r, c) is at `c * rows + r`.
 */
export function readMat4(buffer) {
  if (buffer.byteLength < 20) throw new Error('not a MATLAB v4 file (too short)');
  const dv = new DataView(buffer);

  // Byte order is unknown up front, so try little-endian and sanity-check MOPT.
  let littleEndian = true;
  let mopt = dv.getUint32(0, true);
  if (mopt > 9999) {
    littleEndian = false;
    mopt = dv.getUint32(0, false);
  }
  if (mopt > 9999) throw new Error('not a MATLAB v4 file (bad type word)');

  const order = Math.floor(mopt / 1000);
  const precision = Math.floor((mopt % 100) / 10);
  const matrixType = mopt % 10;
  if (matrixType !== 0) throw new Error(`unsupported matrix type ${matrixType} (want full, not sparse/text)`);
  const spec = PRECISION[precision];
  if (!spec) throw new Error(`unsupported numeric precision ${precision}`);
  // `order` 0 = IEEE little-endian, 1 = IEEE big-endian. Trust it over the guess.
  if (order === 0 || order === 1) littleEndian = order === 0;

  const rows = dv.getUint32(4, littleEndian);
  const cols = dv.getUint32(8, littleEndian);
  const imagf = dv.getUint32(12, littleEndian);
  const nameLength = dv.getUint32(16, littleEndian);
  if (20 + nameLength > buffer.byteLength) {
    throw new Error('not a MATLAB v4 file (name length runs past the end)');
  }

  let offset = 20;
  const nameBytes = new Uint8Array(buffer, offset, nameLength);
  offset += nameLength;
  let name = '';
  for (let i = 0; i < nameLength && nameBytes[i] !== 0; i++) name += String.fromCharCode(nameBytes[i]);

  const count = rows * cols;
  const need = offset + count * spec.bytes;
  if (need > buffer.byteLength) {
    throw new Error(`truncated .mat: need ${need} bytes for ${rows}x${cols}, have ${buffer.byteLength}`);
  }

  let data;
  if (precision === 0 && littleEndian && offset % 8 === 0) {
    // Fast path: the bytes already are a little-endian Float64Array.
    data = new Float64Array(buffer, offset, count);
  } else {
    data = new Float64Array(count);
    const { bytes, read } = spec;
    for (let i = 0; i < count; i++) data[i] = read(dv, offset + i * bytes, littleEndian);
  }

  if (imagf) {
    // PhysiCell never writes complex data; ignore the imaginary block if present.
    console.warn(`readMat4: ignoring imaginary part of "${name}"`);
  }
  return { name, rows, cols, data };
}
