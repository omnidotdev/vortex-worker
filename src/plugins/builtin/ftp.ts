/**
 * Built-in FTP/SFTP Plugin
 *
 * File transfer operations via FTP and SFTP protocols.
 */

import { assertSafeHost } from "lib/ssrf";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** FTP connection config */
interface FtpConfig {
  /** Remote host */
  host: string;
  /** Port (21 for FTP, 22 for SFTP) */
  port?: number;
  /** Username */
  username: string;
  /** Password */
  password?: string;
  /** Use SFTP instead of FTP */
  secure?: boolean;
  /** Private key path for SFTP */
  privateKeyPath?: string;
  /** Connection timeout in ms */
  timeout?: number;
}

/** Upload input */
interface UploadInput extends FtpConfig {
  /** Local file path */
  localPath: string;
  /** Remote destination path */
  remotePath: string;
}

/** Download input */
interface DownloadInput extends FtpConfig {
  /** Remote file path */
  remotePath: string;
  /** Local destination path */
  localPath: string;
}

/** List directory input */
interface ListInput extends FtpConfig {
  /** Remote directory path */
  path?: string;
}

/** Delete input */
interface DeleteInput extends FtpConfig {
  /** Remote path to delete */
  path: string;
  /** Delete directory recursively */
  recursive?: boolean;
}

/** Rename/move input */
interface RenameInput extends FtpConfig {
  /** Source path */
  from: string;
  /** Destination path */
  to: string;
}

/** Make directory input */
interface MkdirInput extends FtpConfig {
  /** Directory path to create */
  path: string;
  /** Create parent directories */
  recursive?: boolean;
}

/** File info input */
interface InfoInput extends FtpConfig {
  /** Remote file path */
  path: string;
}

/**
 * Execute SFTP/SCP command using Bun shell.
 */
const execSftp = async (
  config: FtpConfig,
  commands: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  // SSRF protection: reject connections to private/internal hosts
  await assertSafeHost(config.host);

  const port = config.port ?? (config.secure ? 22 : 21);

  if (config.secure || port === 22) {
    // Use SFTP
    const sftpArgs: string[] = [];
    sftpArgs.push("-o", "StrictHostKeyChecking=accept-new");
    sftpArgs.push("-o", "BatchMode=yes");
    sftpArgs.push("-P", String(port));

    if (config.privateKeyPath) {
      sftpArgs.push("-i", config.privateKeyPath);
    }

    sftpArgs.push(`${config.username}@${config.host}`);

    // Create batch file content
    const batchContent = commands.join("\n");

    const proc = Bun.spawn(["sftp", "-b", "-", ...sftpArgs], {
      stdin: new Response(batchContent).body,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
  }

  // For plain FTP, use curl
  const baseUrl = `ftp://${config.username}:${config.password}@${config.host}:${port}`;

  // FTP via curl only supports one command at a time
  const results: string[] = [];

  for (const cmd of commands) {
    const parts = cmd.trim().split(/\s+/);
    const operation = parts[0];

    let curlArgs: string[] = [];

    switch (operation) {
      case "ls":
        curlArgs = ["-s", `${baseUrl}${parts[1] || "/"}`];
        break;
      case "get":
        curlArgs = ["-s", "-o", parts[2], `${baseUrl}${parts[1]}`];
        break;
      case "put":
        curlArgs = ["-s", "-T", parts[1], `${baseUrl}${parts[2]}`];
        break;
      case "rm":
        curlArgs = ["-s", "-Q", `DELE ${parts[1]}`, baseUrl];
        break;
      case "mkdir":
        curlArgs = ["-s", "-Q", `MKD ${parts[1]}`, baseUrl];
        break;
      case "rmdir":
        curlArgs = ["-s", "-Q", `RMD ${parts[1]}`, baseUrl];
        break;
      case "rename":
        curlArgs = [
          "-s",
          "-Q",
          `RNFR ${parts[1]}`,
          "-Q",
          `RNTO ${parts[2]}`,
          baseUrl,
        ];
        break;
      default:
        continue;
    }

    const proc = Bun.spawn(["curl", ...curlArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    results.push(stdout);
  }

  return { stdout: results.join("\n"), stderr: "", exitCode: 0 };
};

/**
 * Upload file to remote server.
 */
const upload = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as UploadInput;

    // SSRF protection: reject connections to private/internal hosts
    await assertSafeHost(input.host);

    if (input.secure || (input.port ?? 22) === 22) {
      // Use SCP for SFTP
      const port = input.port ?? 22;
      const scpArgs: string[] = [];
      scpArgs.push("-o", "StrictHostKeyChecking=accept-new");
      scpArgs.push("-o", "BatchMode=yes");
      scpArgs.push("-P", String(port));

      if (input.privateKeyPath) {
        scpArgs.push("-i", input.privateKeyPath);
      }

      scpArgs.push(input.localPath);
      scpArgs.push(`${input.username}@${input.host}:${input.remotePath}`);

      const proc = Bun.spawn(["scp", ...scpArgs], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        throw new Error(`Upload failed: ${stderr}`);
      }
    } else {
      // Use curl for FTP
      await execSftp(input, [`put ${input.localPath} ${input.remotePath}`]);
    }

    const localFile = Bun.file(input.localPath);
    const size = localFile.size;

    return {
      success: true,
      output: {
        localPath: input.localPath,
        remotePath: input.remotePath,
        host: input.host,
        size,
        protocol: input.secure ? "sftp" : "ftp",
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
 * Download file from remote server.
 */
const download = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as DownloadInput;

    // SSRF protection: reject connections to private/internal hosts
    await assertSafeHost(input.host);

    if (input.secure || (input.port ?? 22) === 22) {
      // Use SCP for SFTP
      const port = input.port ?? 22;
      const scpArgs: string[] = [];
      scpArgs.push("-o", "StrictHostKeyChecking=accept-new");
      scpArgs.push("-o", "BatchMode=yes");
      scpArgs.push("-P", String(port));

      if (input.privateKeyPath) {
        scpArgs.push("-i", input.privateKeyPath);
      }

      scpArgs.push(`${input.username}@${input.host}:${input.remotePath}`);
      scpArgs.push(input.localPath);

      const proc = Bun.spawn(["scp", ...scpArgs], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        throw new Error(`Download failed: ${stderr}`);
      }
    } else {
      // Use curl for FTP
      await execSftp(input, [`get ${input.remotePath} ${input.localPath}`]);
    }

    const localFile = Bun.file(input.localPath);
    const size = localFile.size;

    return {
      success: true,
      output: {
        remotePath: input.remotePath,
        localPath: input.localPath,
        host: input.host,
        size,
        protocol: input.secure ? "sftp" : "ftp",
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
 * List directory contents.
 */
const list = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ListInput;
    const path = input.path ?? "/";

    const result = await execSftp(input, [`ls -la ${path}`]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list directory: ${result.stderr}`);
    }

    // Parse ls output
    const lines = result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("sftp>"));

    const files = lines.map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length >= 9) {
        const permissions = parts[0];
        const size = Number.parseInt(parts[4], 10);
        const name = parts.slice(8).join(" ");
        const type = permissions.startsWith("d")
          ? "directory"
          : permissions.startsWith("l")
            ? "link"
            : "file";
        return { name, type, size, permissions };
      }
      return { name: line };
    });

    return {
      success: true,
      output: {
        path,
        files,
        count: files.length,
        host: input.host,
        protocol: input.secure ? "sftp" : "ftp",
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
 * Delete file or directory.
 */
const remove = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as DeleteInput;

    const commands = input.recursive
      ? [`rm -rf ${input.path}`]
      : [`rm ${input.path}`];

    const result = await execSftp(input, commands);

    if (result.exitCode !== 0 && !result.stderr.includes("No such file")) {
      throw new Error(`Delete failed: ${result.stderr}`);
    }

    return {
      success: true,
      output: {
        path: input.path,
        host: input.host,
        deleted: true,
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
 * Rename or move file.
 */
const rename = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as RenameInput;

    const result = await execSftp(input, [`rename ${input.from} ${input.to}`]);

    if (result.exitCode !== 0) {
      throw new Error(`Rename failed: ${result.stderr}`);
    }

    return {
      success: true,
      output: {
        from: input.from,
        to: input.to,
        host: input.host,
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
 * Create directory.
 */
const mkdir = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as MkdirInput;

    const commands = input.recursive
      ? input.path
          .split("/")
          .filter(Boolean)
          .reduce<string[]>((acc, _part, i, arr) => {
            const path = `/${arr.slice(0, i + 1).join("/")}`;
            acc.push(`mkdir ${path}`);
            return acc;
          }, [])
      : [`mkdir ${input.path}`];

    const result = await execSftp(input, commands);

    // Ignore "already exists" errors
    if (
      result.exitCode !== 0 &&
      !result.stderr.includes("already exists") &&
      !result.stderr.includes("Failure")
    ) {
      throw new Error(`mkdir failed: ${result.stderr}`);
    }

    return {
      success: true,
      output: {
        path: input.path,
        host: input.host,
        created: true,
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
 * Get file info.
 */
const info = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as InfoInput;

    const result = await execSftp(input, [`ls -la ${input.path}`]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get file info: ${result.stderr}`);
    }

    const line = result.stdout
      .trim()
      .split("\n")
      .find((l) => l.trim() && !l.startsWith("sftp>"));

    if (!line) {
      return {
        success: false,
        error: "File not found",
        durationMs: performance.now() - startTime,
      };
    }

    const parts = line.split(/\s+/);
    const permissions = parts[0] ?? "";
    const size = Number.parseInt(parts[4] ?? "0", 10);
    const name = parts.slice(8).join(" ");
    const type = permissions.startsWith("d")
      ? "directory"
      : permissions.startsWith("l")
        ? "link"
        : "file";

    return {
      success: true,
      output: {
        path: input.path,
        name,
        type,
        size,
        permissions,
        host: input.host,
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
 * Check connection.
 */
const check = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as FtpConfig;

    const result = await execSftp(input, ["pwd"]);

    return {
      success: result.exitCode === 0,
      output: {
        connected: result.exitCode === 0,
        host: input.host,
        port: input.port ?? (input.secure ? 22 : 21),
        protocol: input.secure ? "sftp" : "ftp",
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      output: {
        connected: false,
        host: (inputs as unknown as FtpConfig).host,
        error: error instanceof Error ? error.message : String(error),
      },
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * FTP/SFTP built-in plugin definition.
 */
export const ftpPlugin: BuiltinPlugin = {
  id: "builtin:ftp",
  name: "FTP",
  description: "File transfer operations via FTP and SFTP protocols",
  actions: {
    upload: {
      name: "upload",
      description: "Upload file to remote server",
      handler: upload,
    },
    download: {
      name: "download",
      description: "Download file from remote server",
      handler: download,
    },
    list: {
      name: "list",
      description: "List directory contents",
      handler: list,
    },
    remove: {
      name: "remove",
      description: "Delete file or directory",
      handler: remove,
    },
    rename: {
      name: "rename",
      description: "Rename or move file",
      handler: rename,
    },
    mkdir: {
      name: "mkdir",
      description: "Create directory",
      handler: mkdir,
    },
    info: {
      name: "info",
      description: "Get file info",
      handler: info,
    },
    check: {
      name: "check",
      description: "Check connection",
      handler: check,
    },
  },
};
