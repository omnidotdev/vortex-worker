/**
 * Built-in Compression Plugin
 *
 * File compression and decompression operations.
 * Supports gzip, zip, and tar formats.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Gzip input */
interface GzipInput {
  /** Input file path or content */
  input: string;
  /** Is input a file path */
  isFile?: boolean;
  /** Output file path (optional) */
  output?: string;
  /** Compression level (1-9) */
  level?: number;
}

/** Gunzip input */
interface GunzipInput {
  /** Input file path or gzipped content (base64) */
  input: string;
  /** Is input a file path */
  isFile?: boolean;
  /** Output file path (optional) */
  output?: string;
}

/** Zip input */
interface ZipInput {
  /** Files to include */
  files: Array<{
    /** Path within archive */
    path: string;
    /** Source file path or content */
    source: string;
    /** Is source a file path */
    isFile?: boolean;
  }>;
  /** Output zip file path */
  output: string;
  /** Compression level (0-9) */
  level?: number;
  /** Password for encryption */
  password?: string;
}

/** Unzip input */
interface UnzipInput {
  /** Input zip file path */
  input: string;
  /** Output directory */
  output: string;
  /** Extract only specific files */
  files?: string[];
  /** Password for decryption */
  password?: string;
}

/** Tar input */
interface TarInput {
  /** Files to include */
  files: Array<{
    /** Path within archive */
    path: string;
    /** Source file path */
    source: string;
  }>;
  /** Output tar file path */
  output: string;
  /** Compression type */
  compression?: "none" | "gzip" | "bzip2" | "xz";
}

/** Untar input */
interface UntarInput {
  /** Input tar file path */
  input: string;
  /** Output directory */
  output: string;
  /** Extract only specific files */
  files?: string[];
}

/** List archive input */
interface ListArchiveInput {
  /** Archive file path */
  input: string;
  /** Archive type */
  type?: "zip" | "tar" | "auto";
}

/**
 * Gzip compress data.
 */
const gzip = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as GzipInput;
    const zlib = await import("node:zlib");
    const { promisify } = await import("node:util");
    const gzipAsync = promisify(zlib.gzip);

    let data: Buffer;

    if (input.isFile) {
      const file = Bun.file(input.input);
      data = Buffer.from(await file.arrayBuffer());
    } else {
      data = Buffer.from(input.input, "utf-8");
    }

    const options: { level?: number } = {};
    if (input.level) {
      options.level = input.level;
    }

    const compressed = await gzipAsync(data, options);

    if (input.output) {
      await Bun.write(input.output, compressed);

      return {
        success: true,
        output: {
          path: input.output,
          originalSize: data.length,
          compressedSize: compressed.length,
          ratio: Math.round((1 - compressed.length / data.length) * 100),
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        data: compressed.toString("base64"),
        originalSize: data.length,
        compressedSize: compressed.length,
        ratio: Math.round((1 - compressed.length / data.length) * 100),
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Gunzip decompress data.
 */
const gunzip = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as GunzipInput;
    const zlib = await import("node:zlib");
    const { promisify } = await import("node:util");
    const gunzipAsync = promisify(zlib.gunzip);

    let data: Buffer;

    if (input.isFile) {
      const file = Bun.file(input.input);
      data = Buffer.from(await file.arrayBuffer());
    } else {
      data = Buffer.from(input.input, "base64");
    }

    const decompressed = await gunzipAsync(data);

    if (input.output) {
      await Bun.write(input.output, decompressed);

      return {
        success: true,
        output: {
          path: input.output,
          compressedSize: data.length,
          decompressedSize: decompressed.length,
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        data: decompressed.toString("utf-8"),
        compressedSize: data.length,
        decompressedSize: decompressed.length,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Create zip archive.
 */
const zip = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ZipInput;

    // Use Bun's built-in archiver via shell.
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

    await mkdir(dirname(input.output), { recursive: true });

    // Build file list.
    const tempDir = `/tmp/zip_${Date.now()}`;
    await mkdir(tempDir, { recursive: true });

    try {
      for (const file of input.files) {
        const destPath = `${tempDir}/${file.path}`;
        await mkdir(dirname(destPath), { recursive: true });

        if (file.isFile) {
          const content = await Bun.file(file.source).arrayBuffer();
          await Bun.write(destPath, content);
        } else {
          await Bun.write(destPath, file.source);
        }
      }

      // Create zip using native command.
      const proc = Bun.spawn(
        ["zip", "-r", input.level ? `-${input.level}` : "-6", input.output, "."],
        {
          cwd: tempDir,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`zip failed: ${stderr}`);
      }

      const outputFile = Bun.file(input.output);

      return {
        success: true,
        output: {
          path: input.output,
          fileCount: input.files.length,
          size: outputFile.size,
        },
        durationMs: performance.now() - startTime,
      };
    } finally {
      // Cleanup temp dir.
      Bun.spawn(["rm", "-rf", tempDir]);
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Extract zip archive.
 */
const unzip = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as UnzipInput;
    const { mkdir } = await import("node:fs/promises");

    await mkdir(input.output, { recursive: true });

    const args = ["-o", input.input, "-d", input.output];

    if (input.files && input.files.length > 0) {
      args.push(...input.files);
    }

    if (input.password) {
      args.unshift("-P", input.password);
    }

    const proc = Bun.spawn(["unzip", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    if (exitCode !== 0 && exitCode !== 1) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`unzip failed: ${stderr}`);
    }

    // Parse extracted files from output.
    const extractedFiles = stdout
      .split("\n")
      .filter((line) => line.includes("extracting:") || line.includes("inflating:"))
      .map((line) => line.replace(/.*(?:extracting|inflating):\s*/, "").trim());

    return {
      success: true,
      output: {
        path: input.output,
        extractedFiles,
        fileCount: extractedFiles.length,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Create tar archive.
 */
const tar = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as TarInput;
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

    await mkdir(dirname(input.output), { recursive: true });

    // Create temp dir with files.
    const tempDir = `/tmp/tar_${Date.now()}`;
    await mkdir(tempDir, { recursive: true });

    try {
      // Copy files to temp structure.
      for (const file of input.files) {
        const destPath = `${tempDir}/${file.path}`;
        await mkdir(dirname(destPath), { recursive: true });

        const content = await Bun.file(file.source).arrayBuffer();
        await writeFile(destPath, Buffer.from(content));
      }

      // Determine compression flag.
      const compressionFlags: Record<string, string> = {
        none: "",
        gzip: "z",
        bzip2: "j",
        xz: "J",
      };

      const compFlag = compressionFlags[input.compression ?? "none"] ?? "";
      const tarArgs = [`-c${compFlag}f`, input.output, "-C", tempDir, "."];

      const proc = Bun.spawn(["tar", ...tarArgs], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`tar failed: ${stderr}`);
      }

      const outputFile = Bun.file(input.output);

      return {
        success: true,
        output: {
          path: input.output,
          fileCount: input.files.length,
          size: outputFile.size,
          compression: input.compression ?? "none",
        },
        durationMs: performance.now() - startTime,
      };
    } finally {
      Bun.spawn(["rm", "-rf", tempDir]);
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Extract tar archive.
 */
const untar = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as UntarInput;
    const { mkdir } = await import("node:fs/promises");

    await mkdir(input.output, { recursive: true });

    // Auto-detect compression from extension.
    const ext = input.input.toLowerCase();
    let compFlag = "";
    if (ext.endsWith(".gz") || ext.endsWith(".tgz")) compFlag = "z";
    else if (ext.endsWith(".bz2") || ext.endsWith(".tbz2")) compFlag = "j";
    else if (ext.endsWith(".xz") || ext.endsWith(".txz")) compFlag = "J";

    const tarArgs = [`-x${compFlag}f`, input.input, "-C", input.output];

    if (input.files && input.files.length > 0) {
      tarArgs.push(...input.files);
    }

    const proc = Bun.spawn(["tar", ...tarArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tar extract failed: ${stderr}`);
    }

    // List extracted files.
    const listProc = Bun.spawn(["tar", `-t${compFlag}f`, input.input], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const listOutput = await new Response(listProc.stdout).text();
    const extractedFiles = listOutput.trim().split("\n").filter(Boolean);

    return {
      success: true,
      output: {
        path: input.output,
        extractedFiles,
        fileCount: extractedFiles.length,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * List contents of an archive.
 */
const listArchive = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ListArchiveInput;

    // Auto-detect type from extension.
    const ext = input.input.toLowerCase();
    let type = input.type ?? "auto";

    if (type === "auto") {
      if (ext.endsWith(".zip")) type = "zip";
      else if (ext.endsWith(".tar") || ext.endsWith(".tar.gz") || ext.endsWith(".tgz") ||
               ext.endsWith(".tar.bz2") || ext.endsWith(".tbz2") || ext.endsWith(".tar.xz")) {
        type = "tar";
      }
    }

    if (type === "zip") {
      const proc = Bun.spawn(["unzip", "-l", input.input], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      const lines = output.split("\n");

      const files: Array<{ name: string; size: number }> = [];

      for (const line of lines) {
        const match = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/);
        if (match) {
          files.push({ name: match[2], size: Number.parseInt(match[1], 10) });
        }
      }

      return {
        success: true,
        output: {
          type: "zip",
          files,
          fileCount: files.length,
        },
        durationMs: performance.now() - startTime,
      };
    }

    if (type === "tar") {
      let compFlag = "";
      if (ext.endsWith(".gz") || ext.endsWith(".tgz")) compFlag = "z";
      else if (ext.endsWith(".bz2") || ext.endsWith(".tbz2")) compFlag = "j";
      else if (ext.endsWith(".xz") || ext.endsWith(".txz")) compFlag = "J";

      const proc = Bun.spawn(["tar", `-tv${compFlag}f`, input.input], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      const lines = output.trim().split("\n").filter(Boolean);

      const files = lines.map((line) => {
        const parts = line.split(/\s+/);
        return {
          permissions: parts[0],
          size: Number.parseInt(parts[2], 10),
          name: parts.slice(5).join(" "),
        };
      });

      return {
        success: true,
        output: {
          type: "tar",
          files,
          fileCount: files.length,
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Unknown archive type: ${input.input}`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Compression built-in plugin definition.
 */
export const compressionPlugin: BuiltinPlugin = {
  id: "builtin:compression",
  name: "Compression",
  description: "File compression and decompression (gzip, zip, tar)",
  actions: {
    gzip: {
      name: "gzip",
      description: "Compress data with gzip",
      handler: gzip,
    },
    gunzip: {
      name: "gunzip",
      description: "Decompress gzipped data",
      handler: gunzip,
    },
    zip: {
      name: "zip",
      description: "Create zip archive",
      handler: zip,
    },
    unzip: {
      name: "unzip",
      description: "Extract zip archive",
      handler: unzip,
    },
    tar: {
      name: "tar",
      description: "Create tar archive",
      handler: tar,
    },
    untar: {
      name: "untar",
      description: "Extract tar archive",
      handler: untar,
    },
    list: {
      name: "list",
      description: "List contents of an archive",
      handler: listArchive,
    },
  },
};
