#!/usr/bin/env node
// Checks a pull request against the repo's collaboration conventions
// (CONTRIBUTING.md): the title passes commitlint, the body carries every
// heading of the PR template, and, unless the pull request is a draft, every
// issue it closes has all of its acceptance criteria ticked and cites in its
// comments only commits reachable from the PR or `main`. Runs in the
// conventions workflow and locally: `node scripts/check-pr.mjs <payload.json>`
// with a hand-written `pull_request` event payload.
import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [payloadPath] = process.argv.slice(2);
if (!payloadPath) {
  console.error('usage: node scripts/check-pr.mjs <event-payload.json>');
  process.exit(1);
}
const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
const pr = payload.pull_request;
if (!pr) {
  console.error('no pull_request in the event payload');
  process.exit(1);
}

// The findings are collected and reported together, so the author fixes them
// in one pass.
const problems = [];
const fail = (message) => problems.push(message);

// The title passes commitlint, as a squash merge can land it on `main` as a
// commit message. The CLI runs from the repo root so it finds
// `commitlint.config.mjs`, and through `fileURLToPath` so the path resolves
// on Windows too.
const title = pr.title ?? '';
const commitlint = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('../node_modules/@commitlint/cli/cli.js', import.meta.url))],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), input: title, stdio: ['pipe', 'ignore', 'ignore'] },
);
if (commitlint.status !== 0) fail(`the title does not pass commitlint: "${title}"`);

const body = pr.body ?? '';
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
if (closes.length && pr.draft !== true) {
  for (const number of closes) {
    let issue;
    try {
      issue = JSON.parse(
        execFileSync('gh', ['issue', 'view', number, '--repo', payload.repository.full_name, '--json', 'state,body,comments'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch (error) {
      fail(`closes #${number}, but the issue could not be read: ${error.stderr.trim() || error.message}`);
      continue;
    }
    if (issue.state !== 'OPEN') continue;
    const unticked = issue.body.split(/\r?\n/).filter((line) => /^\s*[-*] \[ \]/.test(line)).length;
    if (unticked) fail(`closes #${number}, which has ${unticked} unticked acceptance ${unticked === 1 ? 'criterion' : 'criteria'}`);
    for (const sha of citedCommits(issue.comments.map((comment) => comment.body).join('\n'))) {
      if (!isAncestorOfHead(sha)) fail(`closes #${number}, whose comments cite ${sha}, a commit that is on neither this PR nor main`);
    }
  }
}

// The commits a text cites: the hex strings GitHub knows as commits of this
// repo. A rewritten commit is still known to GitHub, while a hex string that
// is not a commit, such as a runtime version, is no citation.
function citedCommits(text) {
  const commits = new Set();
  for (const hex of new Set(text.match(/\b[0-9a-f]{7,40}\b/g) ?? [])) {
    try {
      commits.add(execFileSync('gh', ['api', `repos/${payload.repository.full_name}/commits/${hex}`, '--jq', '.sha'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim());
    } catch (error) {
      if (!/HTTP (404|422)/.test(error.stderr)) fail(`could not look up ${hex} on GitHub: ${error.stderr.trim() || error.message}`);
    }
  }
  return commits;
}

// In the workflow HEAD is the PR merged into main, so it reaches both. A
// commit the checkout lacks is reachable from neither.
function isAncestorOfHead(sha) {
  return spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' }).status === 0;
}

if (problems.length) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('the pull request follows the collaboration conventions');