// Catches names that are used but never defined, or defined but never used,
// before the suite runs against the real runtime.
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
  { ignores: ['node_modules/', '.worktrees/', '.local/'] },
];
