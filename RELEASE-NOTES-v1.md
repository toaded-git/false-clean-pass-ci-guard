# false-clean-pass v1.0.0

**Catch the "green but broken" pull request — before it merges.**

`false-clean-pass` is a single GitHub Action that detects *false clean passes*: a
PR whose CI is green even though the tests didn't really run, assertions are
empty, a required env var is missing, a failure was swallowed, coverage was
quietly lowered, warnings were suppressed — or the guard itself was weakened.
It bundles seven detector families plus a hard fail — usually scattered across
separate tools — into one required status check, and it watches for changes that
would disable the guard.

---

## What it checks

One status check (`false-clean-pass`) runs all of these on the PR diff:

- **Skipped / focused tests** — new `.skip`, `xit`, `it.only`, `describe.only`.
- **Empty / no-op tests** — tests with no assertions (lightweight assert-count
  heuristic, with room for custom assertion helpers).
- **Suppression creep** — new `eslint-disable`, `@ts-expect-error`, `# type: ignore`
  added in the PR (reasoned suppressions can be exempted).
- **Swallowed failures & guard self-weakening** — new `|| true`,
  `continue-on-error: true`, `--passWithNoTests`, and any change that removes the
  guard step, loosens `fail-on`, or alters its trigger/`if:`/job name — plus a
  self-attestation marker that records whether the guard actually ran for the
  current commit.
- **Missing env** — code that reads an env var not declared in your example/CI env.
- **Coverage ratchet** — coverage threshold or measured coverage dropping below a
  committed baseline.
- **Baseline sealing** — changes to the guard's own baseline files require a
  CODEOWNER-approved, baseline-only PR (fail-closed).

Plus a **hard fail** on a sharp drop in the number of executed tests (not just
"zero tests"), so deleting 199 tests and keeping one trivial test is still caught.

Findings are reported as a pass/fail **Check Run**, inline **annotations**, an
optional **SARIF** upload to the Security tab, and a **PR comment** summary.

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

  # Keep verify as an independent job with `if: always()` so the guard still runs
  # even when the test job fails or is skipped.
  verify:
    runs-on: ubuntu-latest
    needs: [test]
    if: always()
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/download-artifact@v4
        with: { name: junit, path: reports }
      - uses: toaded-git/false-clean-pass-ci-guard@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          test-results-glob: reports/junit.xml
          fail-on: error
```

Pin to the moving major tag `@v1` for automatic patch/minor updates, or a full
`@v1.0.0` for an immutable pin.

---

## Required setup (this is where the enforcement comes from)

The Action reports a result, but merges are only blocked when you configure the
repository:

1. **Branch protection** → require the status check named **`false-clean-pass`**.
   (The check appears in the list after it has run once.)
2. **CODEOWNERS** → seal the baseline files with an **individual** owner:
   ```
   .github/false-clean-pass-*.json  @your-username
   .github/false-clean-pass.yml      @your-username
   ```
   Enable "Require review from Code Owners." Prefer an individual owner: with a
   team owner the guard cannot reliably resolve team membership and may over-block
   legitimate baseline updates.
3. **Permissions** → `pull-requests: write`, `checks: write`, and
   `security-events: write` if you upload SARIF.

No extra secrets or external services: the Action uses the built-in
`GITHUB_TOKEN` only. It is a stateless static/diff checker — no database, no keys.

---

## What it deliberately does *not* catch (honest limits)

- **Self-attestation is detection + logging, not a cryptographic guarantee.** The
  run marker is unsigned, so a step with `checks: write` could forge it. Real
  enforcement comes from branch protection; a forgery-proof signed marker is
  planned for a future release.
- **Static/diff analysis can't see runtime behavior** — over-mocking that never
  exercises real code, runtime-conditional skips, or forged test-result files.
- **GitHub treats a skipped required check as success.** Require the check and use
  the independent `always()` verify job shown above to narrow this gap.

The tool's real value is the orchestration of these checks into one gate plus the
guard-self-weakening detection — not any single check in isolation.

---

## Key inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `github-token` | — | Token for PR diff, Check Run, and comments (`${{ secrets.GITHUB_TOKEN }}`). |
| `fail-on` | `error` | Minimum severity that fails the check: `error`, `warning`, or `never`. |
| `test-results-glob` | — | JUnit XML glob for the zero-test / test-count checks. |
| `coverage-summary` | — | Coverage summary JSON for the coverage ratchet. |
| `ci-env-keys` | — | Comma-separated CI-provided env key **names** (never values). |
| `sarif-path` | `false-clean-pass.sarif` | Where the SARIF report is written. |
| `comment-mode` | `update` | PR comment behavior: `update`, `new`, or `off`. |
| `attestation-mode` | `marker` | Self-attestation marker behavior; `off` to disable. |
| `config-path` | `.github/false-clean-pass.yml` | Optional config file. |

---

## Notes

- Requires GitHub-hosted or compatible runners (Node 20 Action).
- MIT licensed.
- Feedback and issues welcome on the repository.
