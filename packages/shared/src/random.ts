/**
 * Small deterministic randomness. Everything "random" in a campaign (spintax choices, send jitter)
 * is derived from a seed, so the compose preview, a test send and the real send agree, and a retry
 * or restart never changes what a recipient gets.
 */

/** FNV-1a 32-bit hash of a string. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny, well-distributed PRNG returning floats in [0, 1). */
export function seededRandom(seed: number | string): () => number {
  let a = typeof seed === 'number' ? seed >>> 0 : hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
