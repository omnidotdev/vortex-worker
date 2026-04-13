/**
 * Simple glob pattern matcher.
 *
 * Supports `*` as a wildcard for zero or more characters.
 * All other regex-special characters are escaped so the pattern
 * is treated as a literal aside from wildcards.
 *
 * @param pattern - Glob pattern (e.g., "*@stripe.com", "Invoice*")
 * @param value - String to test against the pattern
 * @returns Whether `value` matches the glob pattern
 */
const matchGlob = (pattern: string, value: string): boolean => {
  if (pattern === "*") return true;

  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  return new RegExp(`^${regexPattern}$`, "i").test(value);
};

export default matchGlob;
