// Runs every suite, or only the files named after `npm test --`, with the
// runner's options fixed in one place.
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// An empty match would run no test and still exit 0, so it fails instead.
const pattern = 'test/*.test.ts';
const files: string[] = process.argv.length > 2 ? process.argv.slice(2) : globSync(pattern);
if (files.length === 0) {
  console.error(`no test files match ${pattern}`);
  process.exit(1);
}
const { status } = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-force-exit', '--test-reporter=spec', ...files],
  { stdio: 'inherit' },
);
process.exit(status ?? 1);
