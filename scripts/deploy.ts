#!/usr/bin/env bun
/**
 * Manual release script for publishing `ninox` to npm.
 *
 * Usage:
 *   bun run scripts/deploy.ts [patch|minor|major|X.Y.Z] [options]
 *
 * Positional (default `patch`):
 *   patch|minor|major          Semver bump type applied to the current version.
 *   X.Y.Z                      Explicit version to publish (used as-is).
 *
 * Options:
 *   --dry-run                  Run verification + `npm publish --dry-run` only.
 *                              No version bump, no publish, no git changes.
 *   --yes                      Skip the interactive confirmation prompt.
 *   --tag <dist-tag>           npm dist-tag to publish under (default: latest).
 *   --tag=<dist-tag>           Same as above.
 *   --no-check                 Skip the git working-tree cleanliness check.
 *   --no-git                   Skip the git commit + `v<version>` tag after
 *                              a successful publish.
 *
 * Flow:
 *   1. Preflight  — npm auth (whoami) + clean git tree
 *   2. Verify     — typecheck, lint, tests, API surface check, build
 *   3. Preview    — `npm pack --dry-run` (exactly what would ship)
 *   4. Confirm    — show next version + tarball, ask before publishing
 *   5. Bump       — update package.json (npm version --no-git-tag-version)
 *   6. Publish    — `npm publish` (prepublishOnly re-verifies as a safety net)
 *   7. Git        — commit + tag `v<version>` (unless --no-git)
 *
 * The .npmrc auth token is never read or printed by this script.
 */
import { exec, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const execAsync = promisify(exec);

/** Run a command through a real shell, capturing stdout+stderr. Never throws. */
function run(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return execAsync(command, { cwd: root, maxBuffer: 128 * 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err: { code?: number; stdout?: string; stderr?: string }) => ({
      code: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }),
  );
}

/** Run a command through a real shell, streaming output to the terminal. */
function runStreaming(command: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: root, shell: '/bin/sh', stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Tiny ANSI helpers so output survives non-TTY runs gracefully. */
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

/** Print a message and exit non-zero. */
function fail(msg: string): never {
  console.error(`\n${c.red('✖')} ${msg}`);
  process.exit(1);
}

/**
 * Run a command, capturing output. Aborts the deploy on non-zero exit.
 * Use for quick commands whose output is consumed programmatically.
 */
async function cmd(command: string, label: string): Promise<string> {
  const { code, stdout, stderr } = await run(command);
  const out = `${stdout}${stderr}`;
  if (code !== 0) {
    console.error(out);
    fail(`${label} failed (exit ${code})`);
  }
  return out;
}

/**
 * Run a command, streaming output to the terminal. Aborts on non-zero exit.
 * Use for long-running verification steps so progress is visible.
 */
async function stream(label: string, command: string): Promise<void> {
  console.log(`\n${c.bold('▶')} ${label}`);
  const code = await runStreaming(command);
  if (code !== 0) fail(`${label} failed (exit ${code})`);
}

/** Returns the authenticated npm username, or null if not logged in. */
async function whoami(): Promise<string | null> {
  const { code, stdout } = await run('npm whoami');
  return code === 0 ? stdout.trim() : null;
}

/** True when the git working tree has no staged/unstaged changes. */
async function gitClean(): Promise<boolean> {
  const { code, stdout } = await run('git status --porcelain');
  return code === 0 && stdout.trim() === '';
}

/** Compute the tarball metadata from `npm pack --dry-run`. */
async function packPreview(): Promise<{ filename: string; size: string; contents: string }> {
  const out = await cmd('npm pack --dry-run', 'npm pack --dry-run');
  const filename = out.match(/filename:\s*(\S+\.tgz)/)?.[1] ?? 'unknown';
  const size = out.match(/package size:\s*([\d.]+\s*(?:k|M)?B)/)?.[1] ?? 'unknown';
  return { filename, size, contents: out.trim() };
}

const BUMPS = ['patch', 'minor', 'major'] as const;
type Bump = (typeof BUMPS)[number];

/** Resolve the target version from the current version + bump (or explicit). */
function nextVersion(current: string, bump: string): string {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump; // explicit X.Y.Z
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m)
    fail(
      `cannot compute "${bump}" bump from version "${current}" — pass an explicit version like 1.2.3`,
    );
  const ma = Number(m[1]);
  const mi = Number(m[2]);
  const pa = Number(m[3]);
  if (bump === 'major') return `${ma + 1}.0.0`;
  if (bump === 'minor') return `${ma}.${mi + 1}.0`;
  if (bump === 'patch') return `${ma}.${mi}.${pa + 1}`;
  fail(`unknown bump "${bump}" — expected patch|minor|major|X.Y.Z`);
}

/** Ask the user a yes/no question on stdin. */
function ask(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const onData = (data: Buffer) => {
      process.stdin.off('data', onData);
      resolve(data.toString().trim());
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const bumpArg = args.find((a) => !a.startsWith('--')) ?? 'patch';
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');
  const noCheck = args.includes('--no-check');
  const noGit = args.includes('--no-git');
  const tagFlag = args.find((a) => a === '--tag' || a.startsWith('--tag='));
  const distTag = tagFlag
    ? tagFlag.startsWith('--tag=')
      ? tagFlag.slice('--tag='.length)
      : (args[args.indexOf(tagFlag) + 1] ?? 'latest')
    : 'latest';

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const current = pkg.version;
  const next = nextVersion(current, bumpArg);

  console.log(`${c.bold('\n ninox — manual npm deploy')}`);
  console.log(
    c.dim(
      ` current: v${current}   next: v${next}   dry-run: ${dryRun ? 'yes' : 'no'}   tag: ${distTag}`,
    ),
  );

  // ---- 1. Preflight -------------------------------------------------------
  const user = await whoami();
  if (user) console.log(`${c.green('✓')} npm auth: ${user}`);
  else
    console.log(`${c.yellow('⚠')} not authenticated to npm (npm whoami failed) — publish may fail`);

  if (!dryRun && !noCheck) {
    if (!(await gitClean())) {
      fail('git working tree is not clean — commit or stash changes, or pass --no-check to skip');
    }
    console.log(`${c.green('✓')} git working tree clean`);
  }

  // ---- 2. Verify ----------------------------------------------------------
  for (const [label, cmdStr] of [
    ['Typecheck', 'bun run typecheck'],
    ['Lint', 'bun run lint'],
    ['Tests', 'bun test'],
    ['API surface check', 'bun run check:api'],
    ['Build', 'bun run build'],
  ] as const) {
    await stream(label, cmdStr);
  }

  // ---- 3. Preview ---------------------------------------------------------
  const preview = await packPreview();
  console.log(`\n${c.bold('📦 Tarball preview')} — ${c.green(preview.filename)}, ${preview.size}`);
  console.log(c.dim(preview.contents));

  // ---- 4. Dry run ---------------------------------------------------------
  if (dryRun) {
    await stream('npm publish --dry-run', `npm publish --dry-run --tag ${distTag}`);
    console.log(
      `\n${c.green('✔')} Dry run complete — no version bump, no publish, no git changes.`,
    );
    return;
  }

  // ---- 5. Confirm ---------------------------------------------------------
  if (!yes) {
    if (!process.stdin.isTTY) {
      fail('stdin is not a TTY — pass --yes to skip the confirmation prompt');
    }
    const answer = await ask(`\nPublish v${c.bold(next)} to npm as "${distTag}"? [y/N] `);
    if (!['y', 'yes'].includes(answer.toLowerCase())) {
      console.log(c.dim('Aborted.'));
      process.exit(0);
    }
  }

  // ---- 6. Bump ------------------------------------------------------------
  await cmd(`npm version ${next} --no-git-tag-version`, 'Version bump');
  console.log(`${c.green('✓')} bumped package.json to v${next}`);

  // ---- 7. Publish (prepublishOnly re-runs typecheck/lint/build) -----------
  await stream('npm publish', `npm publish --tag ${distTag}`);
  console.log(`${c.green('✓')} published ninox@${next} to npm (dist-tag "${distTag}")`);

  // ---- 8. Git tag + commit (after a successful publish) -------------------
  if (!noGit) {
    try {
      await cmd('git add package.json', 'git add package.json');
      await cmd(`git commit -m "chore(release): v${next}"`, 'git commit');
      await cmd(`git tag v${next}`, 'git tag');
      console.log(`${c.green('✓')} committed + tagged v${next}`);
    } catch (err) {
      console.warn(
        `${c.yellow('⚠')} git commit/tag step failed: ${(err as Error).message}. ` +
          'The package IS published — commit and tag manually if desired.',
      );
    }
  }

  console.log(`\n${c.green('✔')} Deploy complete: ninox@${next} (dist-tag "${distTag}")`);
}

await main();
