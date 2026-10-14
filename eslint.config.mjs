// Catches names that are used but never defined, or defined but never used,
// before the suite runs against the real runtime. JavaScript only: the
// parser cannot read TypeScript, so .ts files are ignored here — tsc covers
// unused names in them, and knip covers unused exports.
import globals from 'globals';

export default [
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'error',
    },
  },
  { ignores: ['node_modules/', '.worktrees/', '.local/', '**/*.ts'] },
];
