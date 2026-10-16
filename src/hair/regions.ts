// Where hair grows on the placeholder head (head space, metres): the scalp
// above a hairline and a full beard below the cheek line. Used to place the
// locks and to shade the skin under them.

/** Height of the hairline around the head; `a` is the angle from the front (0) to the back (π). */
const HAIRLINE: [number, number][] = [
  [0, 0.067], [0.55, 0.06], [0.9, 0.044], [1.15, 0.012], [1.4, -0.028], [1.62, -0.022], [2.0, -0.03], [2.6, -0.05], [Math.PI, -0.055],
];

/** Upper edge of the beard (cheek line), by angle from the front. */
const BEARD_TOP: [number, number][] = [
  [0, -0.031], [0.3, -0.032], [0.5, -0.03], [0.8, -0.016], [1.15, -0.004], [1.5, 0.0],
];

function curve(table: [number, number][], a: number): number {
  if (a <= table[0][0]) return table[0][1];
  for (let k = 1; k < table.length; k++) {
    const [a1, v1] = table[k];
    if (a <= a1) {
      const [a0, v0] = table[k - 1];
      return v0 + ((v1 - v0) * (a - a0)) / (a1 - a0);
    }
  }
  return table[table.length - 1][1];
}

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** < 1 inside the ear. */
function earDist(x: number, y: number, z: number): number {
  const ex = (Math.abs(x) - 0.074) / 0.024, ey = (y - 0.002) / 0.036, ez = (z + 0.008) / 0.03;
  return Math.sqrt(ex * ex + ey * ey + ez * ez);
}

const angle = (x: number, z: number) => Math.abs(Math.atan2(x, z));

export function isScalp(x: number, y: number, z: number): boolean {
  return y > curve(HAIRLINE, angle(x, z)) && earDist(x, y, z) > 1;
}

/** Lowest point of the beard: just under the jaw at the front, higher toward the ears. */
const beardBottom = (a: number) => (a > 1.0 ? -0.075 : -0.104);
const onLips = (x: number, y: number, z: number) => Math.abs(x) < 0.026 && y > -0.058 && y < -0.042 && z > 0.06;

export function isBeard(x: number, y: number, z: number): boolean {
  const a = angle(x, z);
  if (a > 1.5 || z < -0.025) return false;
  if (y > curve(BEARD_TOP, a) || y < beardBottom(a)) return false;
  return !onLips(x, y, z) && earDist(x, y, z) > 1;
}

/**
 * How much hair shadow the skin gets (0..1): the scalp and beard areas read
 * as dark stubble when they show between locks or after a buzz cut.
 */
export function stubble(x: number, y: number, z: number): number {
  const a = angle(x, z);
  const ear = smoothstep(1, 1.25, earDist(x, y, z));
  const scalp = smoothstep(-0.003, 0.006, y - curve(HAIRLINE, a)) * ear;
  let beard = smoothstep(0.003, -0.005, y - curve(BEARD_TOP, a)) * smoothstep(1.6, 1.4, a) * smoothstep(-0.035, -0.02, z);
  beard *= smoothstep(-0.008, 0.004, y - beardBottom(a)) * ear * (onLips(x, y, z) ? 0 : 1);
  return Math.max(scalp, beard * 0.7);
}
