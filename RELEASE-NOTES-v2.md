# false-clean-pass v2.0.0

**Catch the "green but broken" pull request — now including required checks that were silently turned off.**

`false-clean-pass` is a single GitHub Action that detects *false clean passes*: a PR whose CI is green even though the tests didn't really run, assertions are empty, a required env var is missing, a failure was swallowed, coverage was quietly lowered, warnings were suppressed, or the guard itself was weakened. v2 adds detection for a subtler class: **a required status check that is quietly skipped and reported as success**, plus optional organization-wide evidence of weakening attempts.

> **Pricing note:** every feature in v2 — including the organization evidence report — is **free** right now. A paid organization tier may be introduced later; if it is, existing users will be notified in advance. There is no purchase flow today.

---

## What's new in v2

- **Required-job skip=success detection.** GitHub reports a *skipped* required check as **success**. v2 detects PR changes that would silently skip a required job: a job-level `if:` that excludes this PR, an `on:` trigger narrowed away from `pull_request`, a required job removed/renamed, or the guard's own `requiredJobs` list narrowed. Skip-inducing conditions hard-fail; ambiguous conditions are flagged for review; well-known safe conditions pass (no false-positive storm).
- **Organization Evidence Report (free).** A batch tool aggregates each PR's Evidence Record across an organization's repositories into a single static report (time series, repeat actors, repeat repos) for CI-governance visibility.
- **Free-core accuracy/usability improvements.** `continue-on-error` allowlist (input list + inline `# fcp-allow:` comments), real `allowJobs` scoping, two-stage suppression-reason handling, executed-test-count ratchet refinements, and an opt-in CODEOWNER team fallback.
- **Offline license verification (present, not yet issued).** An Ed25519, network-zero license check and issuer key-rotation mechanism ship in v2, but license issuance is not open — see the pricing note above.

The v1 detectors, the single required status check, network-zero runtime, and `GITHUB_TOKEN`-only operation are all unchanged.

---

## Quick start

```yaml
# .github/workflows/false-clean-pass.yml
name: false-clean-pass
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: write
  checks: write
  security-events: write

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm test -- --reporter=junit --outputFile=reports/junit.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: junit, path: reports/junit.xml }

  verify:
    runs-on: ubuntu-latest
    needs: [test]
    if: always()
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/download-artifact@v4
        with: { name: junit, path: reports }
      - uses: toaded-git/false-clean-pass-ci-guard@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          test-results-glob: reports/junit.xml
          fail-on: error
          # List the branch-protection required checks you want guarded against
          # silent skip=success (keep this in sync with branch protection):
          requiredJobs: "test"
```

Pin to the moving major tag `@v2`, or a full `@v2.0.0` for an immutable pin.

---

## Required setup (this is where the enforcement comes from)

1. **Branch protection** → require the status check named **`false-clean-pass`**.
2. **`requiredJobs`** → list your branch-protection required check names so v2 can catch a required job being silently skipped. Keeping this list in sync with branch protection is your responsibility (the Action cannot read branch protection with the default token).
3. **CODEOWNERS** → seal the guard's baseline/config files with an **individual** owner and enable "Require review from Code Owners."
4. **Permissions** → `pull-requests: write`, `checks: write`, and `security-events: write` if you upload SARIF.

No extra secrets or external services: the runtime uses the built-in `GITHUB_TOKEN` only, stays network-zero, and keeps no state.

---

## What it deliberately does *not* catch (honest limits)

- **Detection misses, by design:** a required job moved behind an *external* reusable workflow, a job hidden behind a dynamic `${{ }}` name, and step-level `if:` (only job-level is watched). Enforcement ultimately comes from branch protection required checks — v2 is detection plus evidence.
- **The organization license gate is honor-system.** It can be bypassed by forking, a one-person org, or moving to a personal repo. This is acknowledged, not papered over.
- **The evidence report is self-attested, not an independent audit.** A record's signature attests that a licensed organization produced it; it does not cryptographically bind the record's contents, so an organization can alter its own records before aggregation. The report is CI-governance evidence input, **not** an independent audit attestation.
- **Static/diff analysis can't see runtime behavior** — over-mocking, runtime-conditional skips, or forged result files.

---

## Key inputs (new in v2)

| Input | Default | Purpose |
| --- | --- | --- |
| `requiredJobs` | — | Comma-separated required check names guarded against silent skip=success. |
| `evidenceOutput` | `fcp-evidence.json` | Where the per-run Evidence Record JSON is written. |
| `license` | — | Optional offline license string (prefer the `FCP_LICENSE` env from an org secret). Not required — all features are free today. |

(All v1 inputs — `github-token`, `fail-on`, `test-results-glob`, `coverage-summary`, `ci-env-keys`, `sarif-path`, `comment-mode`, `attestation-mode`, `config-path` — are unchanged.)

---

## Notes

- Requires GitHub-hosted or compatible runners (Node 20 Action).
- MIT licensed. Feedback and issues welcome on the repository.
