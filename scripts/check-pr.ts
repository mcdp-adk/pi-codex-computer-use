#!/usr/bin/env node
// Checks a pull request against the repo's collaboration conventions
// (CONTRIBUTING.md): the title passes commitlint, the body carries every
// heading of the PR template, and, unless the pull request is a draft, every
// issue it closes has all of its acceptance criteria ticked and cites in its
// comments only commits reachable from the PR or `main`. Runs in the
// conventions workflow and locally: `node scripts/check-pr.ts <payload.json>`
// with a hand-written `pull_request` event payload.
import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The event payload, `gh` answers, and caught errors start as unknown and
// are narrowed before use.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// What a failed `gh` invocation says: its stderr when it carries text,
// otherwise the error's own message. `gh` failures carry stderr; a missing
// `gh` binary carries only a message, so stderr is read conditionally.
function execFailureDetail(error: unknown): string {
  if (isRecord(error)) {
    const stderr: unknown = error['stderr'];
    if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

const [payloadPath] = process.argv.slice(2);
if (!payloadPath) {
  console.error('usage: node scripts/check-pr.ts <event-payload.json>');
  process.exit(1);
}
const payload: unknown = JSON.parse(await readFile(payloadPath, 'utf8'));
if (!isRecord(payload)) {
  console.error('the event payload is not a JSON object');
  process.exit(1);
}
const pr: unknown = payload['pull_request'];
if (!isRecord(pr)) {
  console.error('no pull_request in the event payload');
  process.exit(1);
}
const repository: unknown = payload['repository'];
const repoFullName: unknown = isRecord(repository) ? repository['full_name'] : undefined;
if (typeof repoFullName !== 'string') {
  console.error('no repository.full_name in the event payload');
  process.exit(1);
}

// The findings are collected and reported together, so the author fixes them
// in one pass.
const problems: string[] = [];
const fail = (message: string): void => {
  problems.push(message);
};

// The title passes commitlint, as a squash merge can land it on `main` as a
// commit message. The CLI runs from the repo root so it finds
// `commitlint.config.mjs`, and through `fileURLToPath` so the path resolves
// on Windows too.
const title: string = typeof pr['title'] === 'string' ? pr['title'] : '';
const commitlint = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('../node_modules/@commitlint/cli/cli.js', import.meta.url))],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), input: title, stdio: ['pipe', 'ignore', 'ignore'] },
);
if (commitlint.status !== 0) fail(`the title does not pass commitlint: "${title}"`);

const body: string = typeof pr['body'] === 'string' ? pr['body'] : '';
// Read from the template, so the body's structure is stated once.
for (const line of (await readFile(new URL('../.github/pull_request_template.md', import.meta.url), 'utf8')).split(/\r?\n/)) {
  const heading = line.match(/^(#{1,6} .+)$/)?.[1];
  if (heading && !body.includes(heading)) fail(`the body is missing the "${heading.slice(heading.indexOf(' ') + 1)}" heading`);
}

// GitHub closes an issue for `closes #N`, `fixes #N`, and `resolves #N`, in
// any letter case; `Refs #N` closes nothing.
const closes = [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)/gi)].map(
  (match) => match[1],
);
if (closes.length && pr['draft'] !== true) {
  for (const number of closes) {
    let issue: unknown;
    try {
      issue = JSON.parse(
        execFileSync('gh', ['issue', 'view', number, '--repo', repoFullName, '--json', 'state,body,comments'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch (error) {
      fail(`closes #${number}, but the issue could not be read: ${execFailureDetail(error)}`);
      continue;
    }
    if (!isRecord(issue) || issue['state'] !== 'OPEN') continue;
    const issueBody: string = typeof issue['body'] === 'string' ? issue['body'] : '';
    const unticked = issueBody.split(/\r?\n/).filter((line) => /^\s*[-*] \[ \]/.test(line)).length;
    if (unticked) fail(`closes #${number}, which has ${unticked} unticked acceptance ${unticked === 1 ? 'criterion' : 'criteria'}`);
    const comments: unknown = issue['comments'];
    const commentText: string = Array.isArray(comments)
      ? comments.map((comment) => (isRecord(comment) && typeof comment['body'] === 'string' ? comment['body'] : '')).join('\n')
      : '';
    for (const sha of citedCommits(commentText)) {
      if (!isAncestorOfHead(sha)) fail(`closes #${number}, whose comments cite ${sha}, a commit that is on neither this PR nor main`);
    }
  }
}

// The commits a text cites: the hex strings GitHub knows as commits of this
// repo. A rewritten commit is still known to GitHub, while a hex string that
// is not a commit, such as a runtime version, is no citation.
function citedCommits(text: string): Set<string> {
  const commits = new Set<string>();
  for (const hex of new Set(text.match(/\b[0-9a-f]{7,40}\b/g) ?? [])) {
    try {
      commits.add(execFileSync('gh', ['api', `repos/${repoFullName}/commits/${hex}`, '--jq', '.sha'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim());
    } catch (error) {
      const stderr: unknown = isRecord(error) ? error['stderr'] : undefined;
      if (typeof stderr !== 'string' || !/HTTP (404|422)/.test(stderr)) {
        fail(`could not look up ${hex} on GitHub: ${execFailureDetail(error)}`);
      }
    }
  }
  return commits;
}

// In the workflow HEAD is the PR merged into main, so it reaches both. A
// commit the checkout lacks is reachable from neither.
function isAncestorOfHead(sha: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' }).status === 0;
}

if (problems.length) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('the pull request follows the collaboration conventions');
