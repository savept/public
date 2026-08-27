# Savept Public Repository

This repository is public. Assume every committed byte, Git object, build log, fixture, and generated artifact can be read permanently by anyone.

## Hard boundaries

- Never add private Savept source, secrets, customer data, personal data, internal URLs, private documentation, or proprietary fixtures.
- Public projects must clone, install, lint, typecheck, test, and build without the private repository.
- Never import or reference a path outside this repository.
- Never declare a dependency on a private Savept package.
- Treat standalone public CI as authoritative; passing only inside the private super-workspace is a failure.

## Package resolution

- Use pnpm workspace dependencies, package exports, and TypeScript project references.
- Do not use root TypeScript `paths` aliases for workspace packages.
- Keep package entry points explicit and prohibit unexported deep imports.
- Keep all packages `"private": true` until an architecture decision explicitly adds them to the publication allow-list.
- Use the repository's committed `.tool-versions` through asdf locally and in CI; do not substitute an ambient Node or pnpm version or add a competing Corepack `packageManager` pin.

## Releases

Public npm packages are built and published only from this repository's CI using npm trusted publishing and provenance. Before release, inspect the packed artifact and test it in a clean consumer. The private product repository has no publication authority for these packages.

## Product integration

This repository is never nested inside the private product workspace. Product integration happens through reviewed npm releases or prereleases with explicit semver versions. Do not add source-path links, Git submodules, or cross-repository TypeScript references.
