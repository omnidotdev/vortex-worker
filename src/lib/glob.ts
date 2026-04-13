/**
 * Simple glob pattern matcher (linear time, no regex).
 *
 * Supports `*` as a wildcard for zero or more characters.
 * Uses an iterative segment-based approach to avoid ReDoS risks
 * from converting user-controlled patterns into regexes.
 *
 * @param pattern - Glob pattern (e.g., "*@stripe.com", "Invoice*")
 * @param value - String to test against the pattern
 * @returns Whether `value` matches the glob pattern
 */
const matchGlob = (pattern: string, value: string): boolean => {
  if (pattern === "*") return true;

  // Case-insensitive comparison
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();

  // No wildcard, exact match
  if (!p.includes("*")) return p === v;

  // Split pattern on `*` into literal segments that must appear in order
  const segments = p.split("*");

  // First segment must be a prefix (unless pattern starts with *)
  let pos = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "") continue;

    if (i === 0) {
      // First segment: must match the start of the value
      if (!v.startsWith(seg)) return false;
      pos = seg.length;
    } else if (i === segments.length - 1) {
      // Last segment: must match the end of the value
      if (!v.endsWith(seg)) return false;
      // Ensure it doesn't overlap with already-matched content
      if (v.length - seg.length < pos) return false;
      pos = v.length;
    } else {
      // Middle segment: find next occurrence after current position
      const idx = v.indexOf(seg, pos);
      if (idx === -1) return false;
      pos = idx + seg.length;
    }
  }

  return true;
};

export default matchGlob;
