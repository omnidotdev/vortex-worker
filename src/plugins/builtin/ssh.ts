/**
 * Built-in SSH Plugin
 *
 * Remote command execution and file operations over SSH.
 * Uses native Bun/Node SSH capabilities.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** SSH connection config */
interface SshConfig {
  /** Remote host */
  host: string;
  /** SSH port */
  port?: number;
  /** Username */
  username: string;
  /** Password (prefer key-based auth) */
  password?: string;
  /** Path to private key file */
  privateKeyPath?: string;
  /** Private key content */
  privateKey?: string;
  /** Passphrase for encrypted key */
  passphrase?: string;
  /** Connection timeout in ms */
  timeout?: number;
}

/** Execute command input */
interface ExecInput extends SshConfig {
  /** Command to execute */
  command: string;
  /** Working directory on remote */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Command timeout in ms */
  commandTimeout?: number;
}

/** Upload file input */
interface UploadInput extends SshConfig {
  /** Local file path */
  localPath: string;
  /** Remote destination path */
  remotePath: string;
  /** File permissions (octal string, e.g., "644") */
  mode?: string;
}

/** Download file input */
interface DownloadInput extends SshConfig {
  /** Remote file path */
  remotePath: string;
  /** Local destination path */
  localPath: string;
}

/** List directory input */
interface ListInput extends SshConfig {
  /** Remote directory path */
  path: string;
  /** Include hidden files */
  all?: boolean;
  /** Include file details */
  long?: boolean;
}

/** Check connection input */
interface CheckInput extends SshConfig {
  // Just the connection config
}

/**
 * Execute SSH command using Bun shell.
 * In production, use ssh2 library for full SSH support.
 */
const execSsh = async (
  config: SshConfig,
  command: string,
  timeout = 30000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const port = config.port ?? 22;
  const sshArgs: string[] = [];

  // Build SSH command
  sshArgs.push("-o", "StrictHostKeyChecking=accept-new");
  sshArgs.push("-o", "BatchMode=yes");
  sshArgs.push(
    "-o",
    `ConnectTimeout=${Math.floor((config.timeout ?? 10000) / 1000)}`,
  );
  sshArgs.push("-p", String(port));

  if (config.privateKeyPath) {
    sshArgs.push("-i", config.privateKeyPath);
  }

  sshArgs.push(`${config.username}@${config.host}`);
  sshArgs.push(command);

  const proc = Bun.spawn(["ssh", ...sshArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("SSH command timed out")), timeout);
  });

  const resultPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();

  return Promise.race([resultPromise, timeoutPromise]);
};

/**
 * Execute a command on remote host.
 */
const exec = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ExecInput;

    let command = input.command;

    // Add working directory if specified
    if (input.cwd) {
      command = `cd ${input.cwd} && ${command}`;
    }

    // Add environment variables
    if (input.env) {
      const envPrefix = Object.entries(input.env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      command = `${envPrefix} ${command}`;
    }

    const result = await execSsh(input, command, input.commandTimeout);

    return {
      success: result.exitCode === 0,
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
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
 * Upload file to remote host via SCP.
 */
const upload = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as UploadInput;
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
      throw new Error(`SCP failed: ${stderr}`);
    }

    // Set permissions if specified
    if (input.mode) {
      await execSsh(input, `chmod ${input.mode} ${input.remotePath}`);
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
 * Download file from remote host via SCP.
 */
const download = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as DownloadInput;
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
      throw new Error(`SCP failed: ${stderr}`);
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
 * List directory contents on remote host.
 */
const list = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ListInput;

    let lsFlags = "-1";
    if (input.all) lsFlags += "a";
    if (input.long) lsFlags += "l";

    const result = await execSsh(input, `ls ${lsFlags} ${input.path}`);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list directory: ${result.stderr}`);
    }

    const entries = result.stdout.trim().split("\n").filter(Boolean);

    // Parse long format if used
    let files: Array<{
      name: string;
      type?: string;
      size?: number;
      permissions?: string;
    }>;

    if (input.long) {
      files = entries.map((line) => {
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
    } else {
      files = entries.map((name) => ({ name }));
    }

    return {
      success: true,
      output: {
        path: input.path,
        files,
        count: files.length,
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
 * Check SSH connection.
 */
const check = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CheckInput;

    const result = await execSsh(input, "echo ok", 10000);

    return {
      success: result.exitCode === 0 && result.stdout.trim() === "ok",
      output: {
        connected: result.exitCode === 0,
        host: input.host,
        port: input.port ?? 22,
        username: input.username,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      output: {
        connected: false,
        host: (inputs as unknown as CheckInput).host,
        error: error instanceof Error ? error.message : String(error),
      },
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Execute multiple commands in sequence.
 */
const script = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SshConfig & {
      commands: string[];
      stopOnError?: boolean;
    };

    const results: Array<{
      command: string;
      stdout: string;
      stderr: string;
      exitCode: number;
    }> = [];
    let hasError = false;

    for (const command of input.commands) {
      const result = await execSsh(input, command);
      results.push({ command, ...result });

      if (result.exitCode !== 0) {
        hasError = true;
        if (input.stopOnError !== false) {
          break;
        }
      }
    }

    return {
      success: !hasError,
      output: {
        results,
        executedCount: results.length,
        totalCount: input.commands.length,
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
 * SSH built-in plugin definition.
 */
export const sshPlugin: BuiltinPlugin = {
  id: "builtin:ssh",
  name: "SSH",
  description: "Remote command execution and file operations over SSH",
  actions: {
    exec: {
      name: "exec",
      description: "Execute a command on remote host",
      handler: exec,
    },
    upload: {
      name: "upload",
      description: "Upload file to remote host via SCP",
      handler: upload,
    },
    download: {
      name: "download",
      description: "Download file from remote host via SCP",
      handler: download,
    },
    list: {
      name: "list",
      description: "List directory contents on remote host",
      handler: list,
    },
    check: {
      name: "check",
      description: "Check SSH connection",
      handler: check,
    },
    script: {
      name: "script",
      description: "Execute multiple commands in sequence",
      handler: script,
    },
  },
};
