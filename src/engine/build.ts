import { pack565 } from './color';
import { BLOCK, type Field } from './grid';

export interface SampleOut {
  d: number;
  r: number;
  g: number;
  b: number;
}

/** Evaluates a shape at a world position: writes distance (metres) and sRGB colour. */
export type Sampler = (x: number, y: number, z: number, out: SampleOut) => void;

/**
 * Fills `field` from `sample`, evaluating every cell only near the surface.
 * Each 4³ block is first sampled at its centre; if the surface cannot reach
 * the block (given the shape's Lipschitz bound) the block is filled with the
 * saturated inside/outside value instead. Cells on the grid boundary are
 * forced outside so the extracted surface is always closed.
 */
export function buildField(field: Field, sample: Sampler, lipschitz = 1): void {
  const { nx, ny, nz, cell, ox, oy, oz, shape, color } = field;
  const half = (BLOCK - 1) / 2;
  const reach = field.band + lipschitz * Math.sqrt(3) * half * cell;
  const out: SampleOut = { d: 0, r: 0, g: 0, b: 0 };

  for (let kb = 0; kb < nz; kb += BLOCK) {
    const k1 = Math.min(kb + BLOCK, nz);
    for (let jb = 0; jb < ny; jb += BLOCK) {
      const j1 = Math.min(jb + BLOCK, ny);
      for (let ib = 0; ib < nx; ib += BLOCK) {
        const i1 = Math.min(ib + BLOCK, nx);
        sample(ox + (ib + half) * cell, oy + (jb + half) * cell, oz + (kb + half) * cell, out);
        const far = Math.abs(out.d) > reach;
        const fill = out.d > 0 ? 127 : -127;
        field.near[ib / BLOCK + field.kx * (jb / BLOCK + field.ky * (kb / BLOCK))] = far ? 0 : 1;
        for (let k = kb; k < k1; k++) {
          for (let j = jb; j < j1; j++) {
            let o = ib + nx * (j + ny * k);
            for (let i = ib; i < i1; i++, o++) {
              if (far) {
                shape[o] = fill;
                color[o] = 0;
              } else {
                sample(ox + i * cell, oy + j * cell, oz + k * cell, out);
                shape[o] = field.quantize(out.d);
                color[o] = pack565(out.r, out.g, out.b);
              }
            }
          }
        }
      }
    }
  }
  forceBoundaryOutside(field);
}

function forceBoundaryOutside(field: Field): void {
  const { nx, ny, nz, shape } = field;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const edgeRow = k === 0 || k === nz - 1 || j === 0 || j === ny - 1;
      const row = nx * (j + ny * k);
      if (edgeRow) {
        shape.fill(127, row, row + nx);
      } else {
        shape[row] = 127;
        shape[row + nx - 1] = 127;
      }
    }
  }
}
