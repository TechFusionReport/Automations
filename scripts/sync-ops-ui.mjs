import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRepo = 'TechFusionReport/Website';
const root = fileURLToPath(new URL('../', import.meta.url));
const ui = join(root, 'ops');
const provenance = join(root, 'ops-sync.json');
const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === '--check';

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'credential.helper=', '-c', 'http.extraHeader=', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

async function entries(directory, prefix = '') {
  const files = new Map();
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      for (const [child, data] of await entries(directory, path)) files.set(child, data);
    } else {
      const fullPath = join(directory, path);
      files.set(path, entry.isSymbolicLink()
        ? { link: await readlink(fullPath) }
        : { bytes: await readFile(fullPath) });
    }
  }
  return files;
}

async function main() {
  let ref = 'preview';
  if (check) {
    const recorded = JSON.parse(await readFile(provenance, 'utf8'));
    if (recorded.sourceRepo !== sourceRepo) throw new Error('Unexpected source repository in ops-sync.json');
    ref = recorded.ref;
  } else if (args.length === 2 && args[0] === '--ref') {
    ref = args[1];
  } else if (args.length) {
    throw new Error('Usage: node scripts/sync-ops-ui.mjs [--ref <ref> | --check]');
  }

  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('Invalid Website ref');
  const checkout = await mkdtemp(join(tmpdir(), 'ops-ui-sync-'));
  try {
    git(checkout, 'init', '--quiet');
    git(checkout, 'fetch', '--quiet', '--depth=1', `https://github.com/${sourceRepo}.git`, ref);
    const commitSha = git(checkout, 'rev-parse', 'FETCH_HEAD^{commit}');
    git(checkout, 'checkout', '--quiet', '--detach', commitSha);
    const upstream = join(checkout, 'ops');
    const expected = await entries(upstream);

    if (check) {
      const actual = await entries(ui).catch(error => {
        if (error.code === 'ENOENT') return new Map();
        throw error;
      });
      if (actual.size !== expected.size || [...expected].some(([path, expectedFile]) => {
        const actualFile = actual.get(path);
        return !actualFile || expectedFile.link !== actualFile.link
          || (expectedFile.bytes && !actualFile.bytes?.equals(expectedFile.bytes));
      })) {
        throw new Error(`ops/ has drifted from Website@${ref}; run npm run sync-ops-ui`);
      }
      console.log(`ops/ matches Website@${ref} (${commitSha})`);
      return;
    }

    if (!expected.get('index.html')?.bytes) throw new Error('Website ops/ is missing index.html');
    await rm(ui, { recursive: true, force: true });
    await cp(upstream, ui, { recursive: true, verbatimSymlinks: true });
    await writeFile(provenance, JSON.stringify({
      sourceRepo, ref, commitSha, syncedAt: new Date().toISOString(),
    }, null, 2) + '\n');
    console.log(`Synced ${expected.size} files from Website@${ref} (${commitSha})`);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
