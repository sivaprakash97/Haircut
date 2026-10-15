/** Cells per brick edge. Bricks are the unit of re-meshing and undo. */
export const BRICK = 8;
/** Cells per edge of the blocks used to track where the surface can be. */
export const BLOCK = 4;

export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * A dense grid of quantized signed distances ("shape") plus a colour per cell.
 * Distances are stored as Int8 over a narrow band of `bandCells` cells; values
 * further from the surface saturate at ±127. Grid points ("cells") sit at
 * origin + index * cell.
 */
export class Field {
  readonly cell: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Distance in metres represented by ±127. */
  readonly band: number;
  readonly shape: Int8Array;
  readonly color: Uint16Array;
  /** Brick counts per axis. */
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  /** 1 for each BLOCK³ block whose cells may hold non-saturated values (i.e. may contain surface). */
  readonly near: Uint8Array;
  readonly kx: number;
  readonly ky: number;
  readonly kz: number;

  constructor(bounds: Bounds, cell: number, bandCells = 4) {
    this.cell = cell;
    [this.ox, this.oy, this.oz] = bounds.min;
    this.nx = Math.ceil((bounds.max[0] - bounds.min[0]) / cell) + 1;
    this.ny = Math.ceil((bounds.max[1] - bounds.min[1]) / cell) + 1;
    this.nz = Math.ceil((bounds.max[2] - bounds.min[2]) / cell) + 1;
    this.band = bandCells * cell;
    const n = this.nx * this.ny * this.nz;
    this.shape = new Int8Array(n);
    this.color = new Uint16Array(n);
    this.bx = Math.ceil((this.nx - 1) / BRICK);
    this.by = Math.ceil((this.ny - 1) / BRICK);
    this.bz = Math.ceil((this.nz - 1) / BRICK);
    this.kx = Math.ceil(this.nx / BLOCK);
    this.ky = Math.ceil(this.ny / BLOCK);
    this.kz = Math.ceil(this.nz / BLOCK);
    this.near = new Uint8Array(this.kx * this.ky * this.kz);
  }

  get cellCount(): number {
    return this.shape.length;
  }

  get brickCount(): number {
    return this.bx * this.by * this.bz;
  }

  /** Bricks that can contain surface: those overlapping a `near` block (corners inclusive). */
  activeBricks(): Int32Array {
    const out: number[] = [];
    for (let bz = 0; bz < this.bz; bz++) {
      for (let by = 0; by < this.by; by++) {
        for (let bx = 0; bx < this.bx; bx++) {
          if (this.bricksNear(bx, by, bz)) out.push(bx + this.bx * (by + this.by * bz));
        }
      }
    }
    return Int32Array.from(out);
  }

  private bricksNear(bx: number, by: number, bz: number): boolean {
    const k0 = Math.floor((bz * BRICK) / BLOCK), k1 = Math.floor(Math.min(bz * BRICK + BRICK, this.nz - 1) / BLOCK);
    const j0 = Math.floor((by * BRICK) / BLOCK), j1 = Math.floor(Math.min(by * BRICK + BRICK, this.ny - 1) / BLOCK);
    const i0 = Math.floor((bx * BRICK) / BLOCK), i1 = Math.floor(Math.min(bx * BRICK + BRICK, this.nx - 1) / BLOCK);
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) if (this.near[i + this.kx * (j + this.ky * k)]) return true;
      }
    }
    return false;
  }

  idx(i: number, j: number, k: number): number {
    return i + this.nx * (j + this.ny * k);
  }

  quantize(d: number): number {
    const q = Math.round((d / this.band) * 127);
    return q > 127 ? 127 : q < -127 ? -127 : q;
  }

  /** Trilinear distance in metres at continuous grid coordinates (clamped to the grid). */
  sampleGrid(gx: number, gy: number, gz: number): number {
    const mx = this.nx - 1.0001, my = this.ny - 1.0001, mz = this.nz - 1.0001;
    if (gx < 0) gx = 0; else if (gx > mx) gx = mx;
    if (gy < 0) gy = 0; else if (gy > my) gy = my;
    if (gz < 0) gz = 0; else if (gz > mz) gz = mz;
    const i = gx | 0, j = gy | 0, k = gz | 0;
    const fx = gx - i, fy = gy - j, fz = gz - k;
    const sy = this.nx, sz = this.nx * this.ny;
    const o = i + sy * j + sz * k;
    const s = this.shape;
    const c00 = s[o] + (s[o + 1] - s[o]) * fx;
    const c10 = s[o + sy] + (s[o + sy + 1] - s[o + sy]) * fx;
    const c01 = s[o + sz] + (s[o + sz + 1] - s[o + sz]) * fx;
    const c11 = s[o + sy + sz] + (s[o + sy + sz + 1] - s[o + sy + sz]) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    return ((c0 + (c1 - c0) * fz) * this.band) / 127;
  }

  /** Trilinear distance in metres at a world position. */
  sampleWorld(x: number, y: number, z: number): number {
    return this.sampleGrid((x - this.ox) / this.cell, (y - this.oy) / this.cell, (z - this.oz) / this.cell);
  }
}
