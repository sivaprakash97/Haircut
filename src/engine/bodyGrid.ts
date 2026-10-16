import type { BodyGrid } from '../hair/body';
import { buildField } from './build';
import { Field } from './grid';
import { headSDF } from './head';

/** Where hair can reach: the bust plus room for long hair around it. */
const BODY_BOUNDS = { min: [-0.2, -0.27, -0.16], max: [0.2, 0.16, 0.17] } as const;

/**
 * The head and shoulders as a collision grid for the hair. The cell is fixed
 * at 6 mm whatever the render quality, so the physics is identical on every
 * device (the distances are smooth, so trilinear lookups stay accurate), and
 * a wide band lets outer hair layers keep their distance from the skin.
 */
export function buildBodyGrid(): BodyGrid {
  const f = new Field(BODY_BOUNDS, 0.006, 6);
  buildField(f, (x, y, z, out) => {
    out.d = headSDF(x, y, z);
  }, 1.2);
  return { data: f.shape, nx: f.nx, ny: f.ny, nz: f.nz, ox: f.ox, oy: f.oy, oz: f.oz, cell: f.cell, band: f.band };
}
