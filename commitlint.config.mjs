// Conventional Commits, enforced locally by the .githooks/commit-msg hook and
// in CI by `npx commitlint --from ... --to ...`. This repo's commits are a
// title only: no scope (`fix(repl): x` is rejected; `fix: x` passes) and no
// body.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-empty': [2, 'always'],
    'body-empty': [2, 'always'],
  },
};