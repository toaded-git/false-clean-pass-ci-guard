# false-clean-pass-ci-guard

`false-clean-pass` is a single GitHub Action status check for PRs that look green while test or CI trust was weakened. It aggregates seven detector families plus the hard fail for "0 executed tests" into one Check Run, annotations, SARIF, and one idempotent PR comment.

This tool is intentionally not a SaaS and has no database. It is a stateless Node 20 JavaScript Action.

## What It Detects

| Area | Signal |
| --- | --- |
| Skipped or focused tests | New `.skip`, `.only`, `xit`, `fit`, Python skip markers |
| Empty assertions | New no-op tests, empty bodies, tests with no assertion signal |
| Missing env keys | Code references not declared in `.env.example` or `ci-env-keys` |
| Ignored failures | `continue-on-error: true`, `|| true`, `exit 0`, `--passWithNoTests` |
| Guard weakening | Removing the guard step, weakening `fail-on`, removing `test-results-glob` |
| Coverage ratchet | Coverage threshold drops and summary-vs-baseline drops |
| Suppression ratchet | New suppression comments and total count growth |
| Baseline guard | Changes to `.github/false-clean-pass-*.json` |
| Required job skip guard | Required job disappearance, skip-risk job `if:`, pull_request trigger narrowing, `requiredJobs` narrowing |
| Hard fail | JUnit reports 0 executed tests |

## Consumer Workflow

Use `false-clean-pass` as the required status check name in branch protection.

```yaml
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
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test -- --reporter=junit --outputFile=junit.xml

  verify:
    runs-on: ubuntu-latest
    needs: [test]
    if: always()
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: toaded-git/false-clean-pass-ci-guard@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          requiredJobs: test,lint,false-clean-pass
          test-results-glob: junit.xml
          coverage-summary: coverage/coverage-summary.json
          ci-env-keys: DATABASE_URL,JWT_SECRET
          fail-on: error
          sarif-path: false-clean-pass.sarif
          evidenceOutput: fcp-evidence.json
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: false-clean-pass.sarif
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: fcp-evidence-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}
          path: fcp-evidence.json
```

The important shape here is running `verify` as an independent job with `if: always()`. If the test job fails, is skipped, or produces suspicious output, the guard still runs and records the reason — a co-located check would be skipped along with the job it is meant to guard.

## Action Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config-path` | `.github/false-clean-pass.yml` | Optional config file path. |
| `github-token` | | `${{ secrets.GITHUB_TOKEN }}`. Used for diff, Check Run, PR comment. |
| `fail-on` | `error` | `error`, `warning`, or `never`. |
| `sarif-path` | `false-clean-pass.sarif` | Output SARIF 2.1.0 file. |
| `test-results-glob` | | JUnit XML glob for zero-tests and test-count ratchet. |
| `base-test-results-glob` | | Optional baseline JUnit glob. |
| `test-count-baseline` | `.github/false-clean-pass-test-count.json` | Optional executed-test-count baseline JSON. |
| `coverage-summary` | | Coverage summary JSON path. |
| `ci-env-keys` | | Comma-separated env key names only, never values. |
| `comment-mode` | `update` | `update`, `new`, or `off`. |
| `attestation-mode` | `marker` | `marker` or `off`; marker is non-cryptographic. |
| `requiredJobs` | | Comma-separated required check names to protect against skip-as-success workflow weakening. Keep this synchronized with branch protection. |
| `evidenceOutput` | `fcp-evidence.json` | Output unsigned Evidence Record JSON file. |

Outputs: `result`, `error-count`, `warning-count`, `sarif-path`, `evidence-path`.

## Config Schema

Create `.github/false-clean-pass.yml` when defaults are not enough.

| Key | Purpose |
| --- | --- |
| `failOn` | Default failure threshold when `with.fail-on` is not supplied. |
| `testGlobs` | Test file globs. |
| `detectors.skippedTests` | Skip/focus severities and toggles. |
| `detectors.emptyAssertions` | Empty body, no-assertion, custom assertion settings. |
| `detectors.envMissing` | Required, optional, ignored, known-provided env key names. |
| `detectors.ignoredFailures` | Failure ignore patterns and guard-weakening settings. |
| `detectors.coverageRatchet` | Coverage baseline and tolerance. |
| `detectors.suppressionRatchet` | New suppression limit and total baseline. |
| `baselineGuard` | Baseline file patterns and CODEOWNER approval behavior. |
| `requiredJobs` | Top-level required check list used by the required job skip guard. |
| `detectors.requiredJobSkip` | Required job skip guard toggle and required check list override. |
| `testCountRatchet` | Executed-test-count baseline and skip ratio limit. |
| `zeroTests` | Alias for test-count settings used by the hard fail path. |

Secrets are not configured here. Only key names such as `JWT_SECRET` should appear.

## Branch Protection

The Action alone is a reporter. Merge blocking comes from GitHub branch protection:

1. Go to branch protection for `main`.
2. Enable required status checks.
3. Add required status check `false-clean-pass`.

Do not rely on the job name generated by a larger workflow. The intended required check is the Check Run named `false-clean-pass`.

`requiredJobs` is the guard's primary source for the list of protected checks because the GitHub branch protection API usually requires admin permission and often returns 403 to the default token. Keeping `with.requiredJobs` synchronized with the actual branch protection required checks is the repository owner's responsibility. If this Action sees `with.requiredJobs` narrowed in a PR, it treats that as `required_config_narrowed` and fails.

## Required Job Skip Detection

This detector catches:

- required jobs with confirmed static mappings that disappear or are renamed;
- matrix combinations removed from a required job;
- job-level `if:` additions that clearly create skip risk, such as actor/ref/event exclusions;
- `pull_request` trigger narrowing, including added `paths-ignore` and conservative boundary-glob changes;
- `with.requiredJobs` shrinking from base to head.

It intentionally does not hard-fail when the mapping is not statically knowable. External reusable workflows, local reusable workflows that cannot be parsed, and dynamic job names using `${{ }}` are recorded as `mapping_unresolved` warnings in the Evidence Record instead of failing the PR as a false positive.

Known limits:

- external reusable workflow internals are not inspected;
- dynamic job names are warning-only;
- step-level `if:` is not detected here; this detector watches job-level `if:`;
- direct branch protection changes in the GitHub UI are outside PR diff analysis.

Each run writes an unsigned Evidence Record JSON. In this M2 implementation, `license.org=false` and `signature=null`; signing and organization aggregation are not implemented here.

## Baseline CODEOWNER Sealing

Baseline files such as `.github/false-clean-pass-coverage.json`, `.github/false-clean-pass-suppressions.json`, and `.github/false-clean-pass-test-count.json` are trust inputs. Functional PRs must not edit them.

Operational rule:

- Baseline updates happen in a separate PR.
- That PR should carry the `baseline-update` label.
- Baseline paths should be protected by CODEOWNERS, for example:

```text
.github/false-clean-pass-*.json @toaded-git
.github/false-clean-pass.yml @toaded-git
.github/workflows/** @toaded-git
```

Prefer an **individual owner** (for example `@toaded-git`) on baseline paths. Approval is verified fail-closed: if it cannot be confirmed, the baseline change is treated as an error. With a **team owner** (for example `@org/security`), the guard cannot reliably resolve team membership through the token's permissions, so legitimate baseline updates can be over-blocked (blocked on every PR even when a real team member approves). Use an individual owner unless you have enabled the optional team-approval fallback.

The current implementation treats CODEOWNER approval as authoritative. The label is a secondary signal and does not downgrade mixed source-code plus baseline changes.

## Guard Weakening And Attestation

Detector 4-B logs and fails common attempts to weaken the guard: removing the step, changing `fail-on: error` to `warning` or `never`, removing `test-results-glob`, weakening triggers, or changing the required check name.

`attestation-mode: marker` adds a Check Run marker for the current SHA and verifies it during the run. This is not an unforgeable defense. It is detection and logging for skip-as-success and required-check confusion. Real enforcement comes from branch protection requiring `false-clean-pass`.

## Local Use

```bash
npm ci
npm test
npm run build
npx tsc --noEmit
node dist/cli.js --root . --base origin/main --head HEAD --sarif-path false-clean-pass.sarif
```

Docker reproduction:

```bash
docker compose run --rm dev
```

`.env.example` lists environment variable names only. Do not put secret values in the repo.

## What This Does Not Catch

- Mocking abuse that makes tests assert fake behavior.
- Runtime conditional skips hidden behind app logic or dynamic test generation.
- Forged or selectively copied test result files.
- A maintainer intentionally approving a weakened workflow.
- Required jobs hidden behind external reusable workflows or dynamic job names, beyond `mapping_unresolved` warnings.
- Step-level `if:` conditions that skip individual steps while the required job still runs.

The `test-results-glob` and baseline guards make the common bypasses visible, but they do not prove the result file is authentic. Evidence signing is not part of this M2 implementation.

## Why One Integrated Guard

Nearby tools are useful but partial. `alls-green` focuses on check aggregation. EnricoMi-style test result reporters publish test output. `jest-ratchet` covers a specific test-count ratchet. `no-only-tests` catches focused tests. This Action intentionally combines these signals with env declaration checks, ignored-failure checks, baseline sealing, SARIF, annotations, PR comments, and one required status check.

The honest tradeoff is that integration increases policy surface area. The benefit is that a PR cannot make one narrow tool pass while weakening another part of CI without leaving a finding in the same required check.
