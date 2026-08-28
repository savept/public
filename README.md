# Savept Public

Canonical public monorepo for Savept SDKs, command-line tools, integration packages, and other open-source components.

This repository is independently cloneable and must build and test without access to Savept's private product repository. Public packages may never depend on private packages.

The repository is in its bootstrap phase. No package is currently approved for publication, and no open-source licence has yet been selected.

## Release validation

`release/allow-list.json` is the only publication allow-list and is intentionally empty. As a result, release execution fails closed and `@savept/workspace-spike` remains private. CI runs behavioral release-validation tests without granting OIDC; its only permission is `contents: read`.

Before any package can be published, Savept must decide and review the open-source licence, npm scope ownership, versioning/release tooling, prerelease naming, and the first allow-listed package. A future publish job must be separately introduced with a protected reviewed environment, an explicit allow-list gate, job-scoped `id-token: write`, and provenance. The committed trusted-publishing policy describes that contract only; it is non-triggerable and contains no executable publishing command or credential.

The public repository alone has release authority. Private product code consumes released public packages through registry semver versions and has no publication authority.
