/**
 * Deterministic identicon generation from an agentId — no external service
 * (SPEC-M4A §2). Pure functions; rendering lives in components/Identicon.tsx.
 */

const GRID_SIZE = 5;
const HALF_COLS = 3; // columns 0-2 are generated, columns 3-4 mirror 1-0

/** 32-bit FNV-1a hash. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface IdenticonData {
  /** 5x5 boolean grid, row-major, horizontally mirrored. */
  cells: boolean[][];
  /** HSL hue, 0-360. */
  hue: number;
}

export function identiconFor(agentId: string): IdenticonData {
  const h = hash32(`agent-launchpad:identicon:${agentId}`);
  const hue = h % 360;

  const cells: boolean[][] = [];
  let bits = h;
  for (let row = 0; row < GRID_SIZE; row++) {
    const rowCells: boolean[] = new Array(GRID_SIZE).fill(false);
    for (let col = 0; col < HALF_COLS; col++) {
      // Rotate through the hash bits as we consume them, reseeding per row
      // so all 25 cells don't collapse to the same low bits.
      bits = Math.imul(bits ^ (row * GRID_SIZE + col + 1), 0x9e3779b1) >>> 0;
      const on = (bits & 1) === 1;
      rowCells[col] = on;
      rowCells[GRID_SIZE - 1 - col] = on;
    }
    cells.push(rowCells);
  }

  return { cells, hue };
}
