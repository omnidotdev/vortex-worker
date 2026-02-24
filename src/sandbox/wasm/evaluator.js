/**
 * QuickJS Evaluator Plugin
 *
 * Extism JS PDK plugin that receives `{source, inputs}` as JSON,
 * evaluates the source via `new Function("input", source)`, and
 * returns `{ok, output}` or `{ok: false, error}`.
 *
 * Compiled to WASM via `extism-js` for use as a sandboxed code runner.
 */

function run() {
  let raw;

  try {
    raw = JSON.parse(Host.inputString());
  } catch {
    Host.outputString(
      JSON.stringify({ ok: false, error: "Invalid JSON input" }),
    );
    return 0;
  }

  const { source, inputs } = raw;

  if (typeof source !== "string") {
    Host.outputString(
      JSON.stringify({ ok: false, error: "source must be a string" }),
    );
    return 0;
  }

  try {
    const fn = new Function("input", source);
    const result = fn(inputs ?? {});

    // Normalise output to a plain object
    const output =
      result !== null &&
      result !== undefined &&
      typeof result === "object" &&
      !Array.isArray(result)
        ? result
        : { result };

    Host.outputString(JSON.stringify({ ok: true, output }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Host.outputString(JSON.stringify({ ok: false, error: message }));
  }

  return 0;
}

module.exports = { run };
