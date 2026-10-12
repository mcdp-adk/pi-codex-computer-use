// Conventional Commits, enforced locally by the .githooks/commit-msg hook and
// in CI by `npx commitlint --from ... --to ...`. This repo's commits never
// carry a scope (`fix(repl): x` is rejected; `fix: x` passes).
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-empty': [2, 'always'],
  },
};