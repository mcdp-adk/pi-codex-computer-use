# Publish to npm under the mcdp-adk organization

The package is published to npm as `@mcdp-adk/pi-codex-computer-use`, under an npm organization named after the GitHub owner, and installing from the git repository stays supported. An npm install needs no clone and no manual dependency install, and a published name can never be reused, so it matches the GitHub repository rather than an npm user. Releases are published by a workflow through npm trusted publishing, so no npm token exists.

## Considered Options

- Git as the only source: pi installs it without a registry, but every install follows a branch or a hand-picked commit rather than a release.
- The unscoped name `pi-codex-computer-use`: already taken on npm by an unrelated package.
- The `@mcdp2alh` user scope: ties a permanent name to the npm account instead of the repository's owner.
