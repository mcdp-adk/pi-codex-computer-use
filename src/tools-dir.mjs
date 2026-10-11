import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Directory that ships the extension's skills (Agent-Skills format). pi's
// `pi install` copies this into the user's skill path; tools can report it.
export const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
