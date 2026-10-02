import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export interface ClaudeCli {
  /** Absolute path of the executable. */
  readonly path: string;
}

export const isWindows = process.platform === 'win32';

/** The configured path, then `PATH`, then where the official installers put the binary. */
function candidates(configuredPath: string): string[] {
  const home = homedir();
  const list = configuredPath.trim() !== '' ? [configuredPath.trim()] : [];
  list.push('claude');
  if (isWindows) {
    list.push(join(home, '.local', 'bin', 'claude.exe'), join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'));
  } else {
    list.push(
      join(home, '.local', 'bin', 'claude'),
      join(home, '.claude', 'local', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    );
  }
  return list;
}

const cache = new Map<string, Promise<ClaudeCli | undefined>>();

/**
 * Finds a working Claude Code CLI by running `claude --version`.
 * Results are cached per configured path; call `clearClaudeCliCache` when settings change.
 */
export function findClaudeCli(configuredPath: string): Promise<ClaudeCli | undefined> {
  let result = cache.get(configuredPath);
  if (!result) {
    result = probeAll(candidates(configuredPath));
    cache.set(configuredPath, result);
    // Don't cache "not found": the user may install it while VS Code is running.
    const pending = result;
    void pending.then((cli) => {
      if (!cli && cache.get(configuredPath) === pending) {
        cache.delete(configuredPath);
      }
    });
  }
  return result;
}

export function clearClaudeCliCache(): void {
  cache.clear();
  failedProbes.clear();
}

/** How long an executable that failed `--version` is skipped, unless it changes first. */
const FAILED_PROBE_TTL_MS = 5 * 60_000;

/**
 * Executables that failed `--version`, with their modification time. A broken install
 * would otherwise cost up to the probe timeout on every generation. Reinstalling or
 * updating changes the modification time, so a fixed install is tried again at once.
 */
const failedProbes = new Map<string, { readonly mtimeMs: number; readonly at: number }>();

/** Exported for tests. */
export async function probeAll(candidateList: readonly string[]): Promise<ClaudeCli | undefined> {
  for (const candidate of candidateList) {
    const path = isAbsolute(candidate) ? ((await isFile(candidate)) ? candidate : undefined) : await findOnPath(candidate);
    if (path === undefined) {
      continue;
    }
    const mtimeMs = await modifiedTime(path);
    const failed = failedProbes.get(path);
    if (failed && failed.mtimeMs === mtimeMs && Date.now() - failed.at < FAILED_PROBE_TTL_MS) {
      continue;
    }
    if (await probe(path)) {
      failedProbes.delete(path);
      return { path };
    }
    if (mtimeMs !== undefined) {
      failedProbes.set(path, { mtimeMs, at: Date.now() });
    }
  }
  return undefined;
}

async function modifiedTime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a command name against `PATH`. Relative entries are skipped: they would
 * resolve against the working directory, which may be a temporary or project folder.
 */
export async function findOnPath(name: string): Promise<string | undefined> {
  const extensions = isWindows && extname(name) === '' ? ['.exe', '.cmd'] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) {
      continue;
    }
    for (const extension of extensions) {
      const path = join(dir, name + extension);
      if (await isFile(path)) {
        return path;
      }
    }
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** True when `<path> --version` succeeds and prints a version number. */
function probe(path: string): Promise<boolean> {
  let command: ClaudeCommand;
  try {
    command = claudeCommand(path, ['--version']);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile(command.file, command.args, { timeout: 10_000, shell: command.shell, windowsHide: true }, (error, stdout) => {
      resolve(!error && /\d+\.\d+\.\d+/.test(stdout));
    });
  });
}

export interface ClaudeCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

/**
 * How to start the CLI. Windows can only run `.cmd` and `.bat` shims (npm installs)
 * through cmd.exe; everything else is started directly, without a shell.
 */
export function claudeCommand(path: string, args: readonly string[]): ClaudeCommand {
  if (isWindows && /\.(?:cmd|bat)$/i.test(path)) {
    return { file: quoteForCmd(path), args: args.map(quoteForCmd), shell: true };
  }
  return { file: path, args, shell: false };
}

/**
 * Quotes one argument for cmd.exe. Inside double quotes cmd.exe still expands `%VAR%`
 * and cannot escape `"`, so arguments containing those (or line breaks) are refused.
 */
export function quoteForCmd(arg: string): string {
  if (/["%\r\n]/.test(arg)) {
    throw new Error(`Unsafe character in a command-line argument for cmd.exe: ${arg}`);
  }
  return /^[\w\-.:\\/]+$/.test(arg) ? arg : `"${arg}"`;
}
