# Releasing QAJitsu

Releases come from CI only (REQ-GEN-15). Nobody publishes from a laptop: `pnpm release` and every package's
`prepublishOnly` refuse to run outside the Release workflow on `main` of this repository (`scripts/publish-guard.mjs`).

## How a release happens

1. Pull requests carry changesets (`pnpm changeset`) for what users notice.
2. When a pull request with changesets merges into `main`, the **Release** workflow (`.github/workflows/release.yml`)
   opens or updates one pull request, `chore(release): version packages`. It is made by code
   (`pnpm version-packages`):
   - versions and `CHANGELOG.md` of every changed package (`changeset version`);
   - `packages/cli/plugins.json`, the plugin versions this CLI installs (`scripts/plugin-catalogue.mjs`);
   - the lockfile and the formatting of what was generated.
3. Read the changelogs in that pull request and rewrite entries that only make sense to maintainers. While QAJitsu is
   `0.x`, a breaking change is a minor version and says so in its entry.
4. Merging it publishes. Every package has the same version: changesets keeps `@qajitsu/*` in one fixed group, so a
   change to one package releases all of them at the next version.

The workflow has three jobs before the image:

- **test**, with read rights and no secrets, runs the install, `pnpm verify`, the contract tests of every plugin as
  installed from its tarball (`tests/e2e/plugins-installed.e2e.test.ts`) and the full release check below.
- **version**, with the rights to push a branch and open a pull request and nothing else (no npm token, no OIDC
  token), opens or updates the version pull request when changesets are pending.
- **release** runs when none are pending, in the `npm-publish` environment, with the npm token and the OIDC token for
  provenance. Before it installs anything, `scripts/unpublished-check.mjs` asks the registry about every package at its
  version:
  - none of them is there: this run publishes;
  - some are, each with the provenance of a run of this workflow on `main` (a release the registry stopped half-way,
    e.g. with npm's limit on how many new packages may be created in a row, `E429`): this run publishes the rest and
    finishes that release. Re-run the failed job, or wait for the next push to `main`;
  - all of them are and the CLI's release tag exists: the release is done, the job does nothing;
  - anything else (a version without that provenance, all of them there but no release run tagged them, the registry
    does not answer): the job fails. `pnpm -r publish` would skip a version that is already there, and the release
    and its image would then carry a tarball someone else published. Look at what is there with `npm view
<package>@<version> --json` before doing anything by hand.

  `pnpm release` then publishes:
  1. the publish guard;
  2. `pnpm clean` and `pnpm build`, so no stale file reaches a package;
  3. the release check without installs (`--no-install`): the tarballs that are published are inspected again;
  4. `pnpm -r publish` with npm provenance: pnpm, not npm, because only pnpm turns `workspace:` ranges into versions;
  5. `scripts/release-tags.mjs` tags each published version (`changeset git-tag`).

  Then `scripts/provenance-check.mjs` reads every package back from the registry: its npm provenance must name this
  repository, `.github/workflows/release.yml`, `refs/heads/main`, a push and this very run (or, when it finishes a
  release, the run that published its start), and must be about the
  tarball the registry serves. A version someone published in the minutes between the decision and the publish, which
  pnpm skipped, fails the job here, before `scripts/github-release.mjs` pushes the tags and creates the GitHub release
  with the CLI's changelog.

The npm token reaches the publish step only. Every action is pinned to a commit.

## The release check

`node scripts/release-check.mjs` (also `pnpm release:check`) runs on every pull request in CI and before every
publish. It packs every package as the release would and refuses when a tarball:

- lacks a file that its `main`, `types`, `exports` or `bin` names;
- keeps a `workspace:` dependency;
- carries tests, build info, environment or key files, or stale build output;
- has a source map that points outside the package;
- misses its `LICENSE`, `NOTICE` or `README.md`, its repository, its Node.js engine or public access;
- has a version other than the release's, or is over 3 MB packed.

Then it installs the CLI from those tarballs with npm into an empty folder, the way a user does, without running any
install script, and runs it with an empty home and no model keys:

- `--version` and `--help`;
- `init` of a new project;
- adding the API runner plugin from its tarball, and the refusal to remove it while the project needs it;
- adding and removing a plugin the project does not need;
- `doctor`, which must find nothing to fix;
- the spec type check of the installed verifier, in the npm layout and in pnpm's: a correct spec passes, one calling a
  method that does not exist is blocked, against the installed build of `@qajitsu/steps`.

The installation must stay under 200 MB and must not contain a plugin that should be installed on demand.

Useful options: `--no-install` (pack and inspect only), `--keep` (keep the work folder to look at it).

## The release image

After the packages are published, four jobs make `ghcr.io/bogiloco/qajitsu` for that version (REQ-GEN-09). No
dependency code ever runs where the image can be pushed, signed or attested.

1. **image-build**, read-only:
   - takes the published tarballs from the registry (`scripts/image-context.mjs --from-registry`) and a lockfile that
     pins every third-party package to the version this repository's lockfile tests; the API and web runner plugins
     are installed next to the CLI, so they are part of the installation and pinned the same way;
   - builds amd64 and arm64 with an SBOM and full provenance into an OCI archive (`ci/docker/Dockerfile.release`;
     `npm ci --ignore-scripts`, the tarballs only mounted for the install, the base pinned by digest);
   - checks the provenance of every tarball again (`scripts/provenance-check.mjs`): only what this run published
     goes into the image, and a published npm version never changes afterwards;
   - nothing of the checkout is built; it is installed (`--ignore-scripts`) only to read the tested versions. QEMU
     and BuildKit, which make every byte of the image, are pinned by digest;
   - loads the amd64 and the arm64 image of the same build, confirms each is the image in the archive
     (`scripts/oci-archive.mjs`), runs `scripts/image-check.mjs` on amd64 and its layer scan (`--layers-only`) on
     arm64, then records the SHA-256 of the archive and the digest of its image index for the next job.
2. **image-publish**, the reusable workflow `.github/workflows/image-publish.yml`, in the `image-publish`
   environment. It is its own file so that the signature and the attestation name it as the signer, not the Release
   workflow, whose other jobs run dependency code:
   - downloads the archive by its artifact id and refuses it unless its SHA-256 and its index digest are the ones
     the build job recorded;
   - refuses when the version tag already holds another image; otherwise pushes the archive with its digests
     unchanged (`skopeo copy --all --preserve-digests`) under the exact version, and checks the registry has the
     archive's digest;
   - signs it without a key (Sigstore, `--recursive`: the index and each platform) and attests its provenance;
   - verifies it the way a user does: only `image-publish.yml`, called for a push to main, is a valid signer, the
     attestation comes from that workflow, and each platform has an SBOM;
   - only then moves the minor-line tag and `latest` (`scripts/image-tags.mjs`; a pre-release moves neither).
3. **image-verify**, read-only: pulls the published image by digest, runs the image check on amd64 and the image on
   arm64.
4. **image-notes**: adds the image, by digest, and the commands below to the GitHub release.

The image runs as the user `qa` (uid 10001) and contains no secret: configuration comes from the mounted project,
secrets from its secret provider (`-e JIRA_TOKEN ...`). Its only build arguments are the version and the commit, since
the provenance publishes every build argument. A run in it records the image by digest when started with
`-e QAJITSU_IMAGE_DIGEST=sha256:...`, marked as declared by whoever started the container: nothing inside a container
can check its own digest. Without it the record says the digest was not given; a tag alone is never recorded.

Checking an image:

```sh
cosign verify ghcr.io/bogiloco/qajitsu@sha256:<digest> \
  --certificate-identity https://github.com/BogiLoco/qajitsu/.github/workflows/image-publish.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository BogiLoco/qajitsu --certificate-github-workflow-ref refs/heads/main \
  --certificate-github-workflow-trigger push
gh attestation verify oci://ghcr.io/bogiloco/qajitsu@sha256:<digest> --repo BogiLoco/qajitsu \
  --signer-workflow BogiLoco/qajitsu/.github/workflows/image-publish.yml --source-ref refs/heads/main --deny-self-hosted-runners
docker buildx imagetools inspect ghcr.io/bogiloco/qajitsu@sha256:<digest> --format '{{ json .SBOM }}'
```

The image check refuses an image when:

- its version or labels are wrong, or it runs as root;
- it sets a secret-looking variable;
- any layer, including one whose files a later layer deletes, holds a credential file or a token or private key in
  a text file;
- its plugins are missing;
- a run does not record its digest;
- the demo does not catch BUG-01 without a network.

It runs on every pull request too (the `image` job, amd64). Locally:

```sh
pnpm build && node scripts/image-context.mjs /tmp/ctx
docker build -f ci/docker/Dockerfile.release --build-arg VERSION=<version> --build-arg REVISION=$(git rev-parse HEAD) -t qj /tmp/ctx
node scripts/image-check.mjs qj <version>
```

## What the repository needs once

- An npm organisation `qajitsu` that owns the `@qajitsu` scope.
- A GitHub environment `npm-publish` (Settings → Environments), limited to the `main` branch, with required reviewers if
  a person should approve each release, holding the secret `NPM_TOKEN`: a granular npm token with publish rights on the
  `@qajitsu` packages only and an expiry date. The first publish of each package needs a token. After it, switch the
  packages to npm trusted publishing for this workflow, revoke the token and set the packages to require two-factor
  authentication and disallow tokens.
- Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests", so the workflow can open
  the version pull request.
- Optionally the secret `RELEASE_PR_TOKEN`, used by the version job only. A pull request opened with the workflow's
  own token gets no CI checks, so with required checks the version pull request would need an administrator to merge
  it. Prefer a GitHub App installed on this repository only, with Contents and Pull requests read and write, and pass
  its short-lived installation token; a fine-grained personal token limited to this repository with the same two
  rights and an expiry date works too. Never a classic token: it reaches every repository of its owner.
- The version pull request is one commit: merge it with a merge commit or a squash.
- A GitHub environment `image-publish`, limited to the `main` branch (required reviewers if a person should approve
  each image).
- A tag ruleset (Settings → Rules → Rulesets) for `@qajitsu/*` tags that only the release can create and nobody can
  move or delete: a release tag is what `scripts/unpublished-check.mjs` takes as "this version was released".
- After the first image is pushed: Packages → `qajitsu` → Package settings → change visibility to public, and connect
  it to this repository. GitHub creates a new container package as private, so nobody could pull it.

## Notes

- The publish guard (`scripts/publish-guard.mjs`) protects against accidents, not against an attacker: it can be
  skipped. What protects the packages is where the token lives: in the environment, reachable by the publish step only.
- `pnpm -r publish` hands each tarball to npm, which signs the provenance. pnpm 11 publishes natively: check provenance
  again before `packageManager` moves past pnpm 10.
