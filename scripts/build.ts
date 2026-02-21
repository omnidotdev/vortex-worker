/**
 * Build script that externalizes npm dependencies while resolving
 * tsconfig path aliases (e.g. `lib/...` via `baseUrl: "src"`).
 *
 * `--packages external` treats ALL bare specifiers as packages,
 * breaking path aliases. This script reads dependency names from
 * package.json and externalizes only those.
 */

import pkg from "../package.json";

const external = Object.keys({
	...pkg.dependencies,
	...pkg.devDependencies,
});

const result = await Bun.build({
	entrypoints: ["src/index.ts", "src/instrumentation.ts"],
	outdir: "build",
	target: "node",
	external,
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

console.log(
	`Bundled ${result.outputs.length} files (${external.length} external packages)`,
);
