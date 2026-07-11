# 설계서: "false clean pass" 방지 CI 가드레일 봇

프로젝트명: `false-clean-pass-ci-guard`
작성일: 2026-07-11
배포물: **단일 GitHub Action** (composite/JS Action, SaaS 아님)
구현 주체: Codex (이 문서는 모호함 없이 그대로 구현 가능해야 함)

---

## 1. 개요 / 문제 정의 / 이 도구가 막는 것

AI 코딩 에이전트가 코드를 대량 생성하면서 "CI 초록불(그린)"의 신뢰성이 무너지고 있다. CI는 통과했지만 실제로는 테스트가 스킵/미실행됐거나, 어서션이 비어 있거나, 필수 env/시크릿이 CI에 없어 코드가 실제로는 돌지 않거나, 워크플로에 `|| true`·`continue-on-error`가 끼어 실패가 삼켜지거나, 커버리지 임계치를 몰래 낮추거나, `eslint-disable`·`# type: ignore` 같은 억제 주석을 늘려 경고를 지우거나, **가드 자신의 baseline 파일·검사 스텝·트리거를 몰래 약화**시킨 상태를 "false clean pass(거짓 통과)"라 부른다. 이 도구는 **PR 단위로 위 7종의 검증 우회·약화 신호를 하나의 GitHub Action(= 단일 상태체크 1개)으로 통합 탐지**하여, 배포 전에 시끄럽게 실패시키고 어노테이션·SARIF·PR 코멘트로 근거를 남긴다.

**정직한 차별성 포지셔닝**: 검출기 1(스킵)·5(커버리지 ratchet)·하드페일(#3)은 각각 `no-only-tests`·`jest-coverage-report-action`/`jest-ratchet`·`alls-green`·EnricoMi 등 **성숙한 개별 도구로 대체 가능**하며 그 자체로는 차별성이 거의 없다. 이 도구의 **유일한 진짜 해자(moat)는 (a) 이 조각들을 하나의 required status check로 묶는 오케스트레이션 편의 + (b) 검출기 4-B(가드 self-attestation)·7(baseline CODEOWNER 봉인)으로 가드 자신의 자기약화를 감시**하는 데 있다. 정적/diff 분석이 원리적으로 못 잡는 것(모킹 남용, 런타임 조건부 스킵, 테스트 결과 파일 위조)은 README "이 도구가 못 잡는 것"에 정직하게 명시한다. **4-B self-attestation은 서명 없는 마커라 `checks: write` 권한을 가진 임의 스텝이 동일 SHA 마커를 위조할 수 있으므로, 그 자체는 "가드 실행 여부 탐지 + 실행 로깅" 보조 신호일 뿐 위조 불가능한 방어가 아니다.** 실제 강제력은 **브랜치 보호(required status check, 사람 설정)**에서 나오며, 마커의 위조 불가능성은 **v2 서명**으로만 보장된다(§9).

---

## 2. MVP 범위 (포함/제외 경계)

승인된 범위: 리서치 결론의 노릴 빈틈 중 **#1(6종 검증을 하나의 상태체크로 통합)** + **#3(env 누락 탐지 + "실행 테스트 급감/0건" 하드 페일)** 을 기본으로 하되, **#2 "설정 봉인 메타 계층"의 일부(baseline CODEOWNER 봉인 + 가드 self-attestation)를 포함해** 검출기 7종으로 확장한다.

### 2.1 포함/제외 경계표

| 영역 | 항목 | MVP 포함 | 근거 / 비고 |
|---|---|:---:|---|
| 통합 게이트 (#1) | 7종 검출기를 단일 Action·단일 상태체크로 오케스트레이션 | 포함 | 승인 범위 핵심 |
| 검출기 1 | 테스트 스킵: `.skip` / `xit` / `it.only` / `describe.only` / `fit` / `xdescribe` / `test.only` | 포함 | 정적 파싱 + PR diff. 개별 대체 도구 존재(차별성 낮음) |
| 검출기 2 | 빈 어서션 / no-op 테스트 (assert 0건) — **경량 assert-카운트 휴리스틱** | 포함 | 뮤테이션 제외(제약 3). 헬퍼 관대 처리로 오탐 완화(§4.2) |
| 검출기 3 | env / 시크릿 누락 (`.env.example` ↔ CI env ↔ 코드 참조 대조) | 포함 | #3. **기본 warning**·플랫폼 allowlist·옵셔널 참조 인식(§4.3) |
| 검출기 4 | 실패 무시(`\|\| true`/`continue-on-error`/`--passWithNoTests`) **+ 4-B: 가드 self-attestation(실행 여부) + `on:`/`if:`/job-name/`fail-on`/`test-results-glob` 약화 감시** | 포함 | #1 + 가드 자기약화 방지 |
| 검출기 5 | 커버리지 임계치 하락 (ratchet: 커밋된 baseline 대비 숫자 감소) | 포함 | #1. 개별 대체 도구 존재(차별성 낮음) |
| 검출기 6 | 억제 주석 증가 — **diff 신규(M1) + 총량 ratchet(M2)**, 기본 `maxNewPerPR=3`+`requireReason=true` | 포함 | #1. 오탐 완화(§4.6) |
| 검출기 7 | **baseline 파일 봉인**: `.github/false-clean-pass-*.json` 변경 시 error, 예외는 **CODEOWNER 승인 실측(fail-closed)** | 포함 | #2 설정 봉인의 일부 |
| 하드 페일 (#3) | **실행 테스트 수 급감 ratchet**(base 대비 급감 → error, 0건은 특수 케이스) | 포함 | #3 강화 |
| 출력 | 단일 상태체크(pass/fail) + 어노테이션 + SARIF + PR 코멘트 | 포함 | 강제력은 브랜치 보호 + self-attestation 결합(§9) |
| 설정 | `.github/false-clean-pass.yml` 스키마 (임계치·on/off 토글·프리셋) | 포함 | §7 |
| 언어 | JS/TS 우선, Python 부분 지원(env·억제주석·스킵 정규식) | 포함 | Python `skipif`는 침묵(§4.1) |
| **암호학적 self-attestation 서명 / 외부 인프라(KMS·서버·DB)** | | **제외 → v2** | MVP는 GITHUB_TOKEN+Check Run 마커만 |
| **메타 우회 방지 (#2) 나머지** | 설정 해시 lockfile 봉인, required-check 대조 자동화 | **제외 → v2** | 제약 2 |
| **뮤테이션 테스팅** | Stryker 등 실제 mutant 실행 | **제외 → v2** | 제약 3 (경량 휴리스틱으로 대체) |
| 훅 우회(`--no-verify`, `HUSKY=0`) 탐지 | reflog/커맨드 감사 | **제외 → v2** | 승인 6종 밖 |
| 다언어 전면 지원(Go/Rust/Java) | | **제외 → v2** | 유지보수 부담(리서치 리스크) |
| SaaS / 대시보드 / DB | | **제외** | 단일 Action(제약 4) |

### 2.2 v2로 분리한 항목 (설계만 남기고 구현 안 함)
- **암호학적 self-attestation 서명**: MVP의 "커밋 SHA 마커 + Check Run 존재/일치" 경량 방식을 넘어, **HMAC/서명 기반 위조 방지 마커**(외부 KMS·시크릿 서명키·서버·DB 도입)로 마커 자체의 위조 불가능성을 보장. MVP는 도입하지 않는다.
- **#2 메타 계층 (나머지)**: (a) 가드 설정(`.github/false-clean-pass.yml`, 워크플로)의 해시 lockfile 봉인. (b) `required status checks` 목록과 실제 실행 job 대조 자동화. (c) CODEOWNERS 강제 자동 검증.
- **뮤테이션 테스팅 옵트인 모드**: 휴리스틱이 "의심"으로 표시한 파일에 한해 Stryker 선택 실행.
- **훅 우회 신호**: CI 이벤트/reflog에서 `--no-verify`·`HUSKY=0`·force-push 흔적 탐지.
- **다언어 규칙팩**: Go(`t.Skip`, `//nolint`), Rust(`#[ignore]`, `#[allow]`), Java(`@Disabled`) 규칙 추가.
- **런타임 false-green 탐지**: 모킹 남용·조건부 `if (CI) return`·항상 200 목 등 정적으로 못 잡는 신호(뮤테이션/런타임 계측 필요).

---

## 3. 아키텍처

### 3.1 실행 모델 (GitHub Action)

**타입**: JavaScript(Node 20) GitHub Action. `action.yml` + 번들된 `dist/index.js`(ncc). composite가 아니라 JS Action인 이유는 diff 파싱·정적 파싱·SARIF 생성·Check Run 마커 조회 로직이 복잡해 코드로 다뤄야 하기 때문.

**트리거(사용자 워크플로에서 지정, Action 자체는 이벤트 비의존)**:
- `pull_request` (opened, synchronize, reopened, labeled, unlabeled) — 주 대상. base↔head diff 확보. **주의(GitHub 동작 명시)**: `pull_request` 이벤트에서 실행되는 **워크플로 정의는 base 브랜치의 것**이다. 따라서 "PR이 가드 스텝을 제거·약화"해도 그 PR 실행에서는 base의 가드가 돈다. 이 사실이 검출기 4-B 설계의 전제이며 한계다(§4.4, §9).
- `push` (선택) — diff 기반 검출기는 이전 커밋과 비교, ratchet은 baseline 파일 사용.

**입력(`with:`) 및 환경**:
| 입력 | 필수 | 기본 | 설명 |
|---|:---:|---|---|
| `config-path` | N | `.github/false-clean-pass.yml` | 설정 파일 경로 |
| `test-results-glob` | N | `` (빈값) | JUnit XML/JSON 테스트 결과 파일 glob. 있으면 실행수 하드페일 활성 |
| `test-count-baseline` | N | `.github/false-clean-pass-testcount.json` | 실행 테스트 수 baseline(하드페일 ratchet용, 검출기 7 봉인 대상) |
| `coverage-summary` | N | `` | 커버리지 요약 파일 경로 |
| `ci-env-keys` | N | `` | CI에 실제 주입된 env 키 이름 목록(쉼표 구분, **값 아님**) |
| `fail-on` | N | `error` | `error` \| `warning` \| `never`. 어느 심각도부터 상태체크를 fail 시킬지 |
| `attestation-mode` | N | `emit-and-verify` | `emit-and-verify` \| `emit-only` \| `off`. self-attestation 마커 동작(§4.4-B) |
| `sarif-output` | N | `false-clean-pass.sarif` | SARIF 파일 출력 경로 |
| `comment-mode` | N | `update` | `update` \| `new` \| `off`. PR 코멘트 동작 |
| `github-token` | Y | — | `${{ secrets.GITHUB_TOKEN }}` 참조. diff·코멘트·체크런·PR reviews API용 |

> 시크릿은 문서/코드에 값으로 쓰지 않는다. `github-token`은 워크플로에서 `${{ secrets.GITHUB_TOKEN }}` 참조로만 전달한다. `ci-env-keys`는 **키 이름 목록만** 받고 값은 절대 받지 않는다.

**출력(`outputs`)**: `result`(`pass`|`fail`), `error-count`/`warning-count`, `sarif-path`, `attestation-sha`(마커에 기록한 head SHA).

**부수효과(side effects)**:
1. **상태체크 1개**: `false-clean-pass` 이름의 Check Run 생성(conclusion = success/failure/neutral). 브랜치 보호에서 required로 지정될 단일 게이트.
2. **self-attestation 마커**: Check Run output(summary) 또는 Check Run text에 `<!-- fcp-attestation sha=<HEAD_SHA> ts=<ISO> -->` 형태 마커를 남김(§4.4-B). 위조 방지 서명은 v2.
3. **어노테이션 / SARIF / PR 코멘트**: findings를 파일·라인 annotation, SARIF 2.1.0, idempotent 마커 코멘트로 출력.
4. **프로세스 exit code**: `fail-on` 정책 위반 시 non-zero.

### 3.2 내부 모듈 구성

```
src/
  index.ts            # Action 엔트리: 입력 파싱 → orchestrator 실행 → 마커 emit → 출력 렌더
  cli.ts              # 로컬 CLI 엔트리(테스트/개발용)
  config/
    schema.ts         # 설정 zod 스키마 + 기본값 + 프리셋 병합
    presets.ts        # node / next / python 프리셋 (env allowlist·assert 헬퍼 포함)
  core/
    orchestrator.ts   # 7개 검출기 + 하드페일 실행, findings 취합, 심각도 판정
    types.ts          # Finding, Severity, DetectorContext, DetectorResult 타입
    context.ts        # DetectorContext 구성: diff, changed files, config, ci-env-keys, prReviews, prLabels, headSha
  git/
    diff.ts           # base↔head diff(octokit compare) + 파일별 added/removed 라인 + 변경 파일 목록
  gh/
    checkrun.ts       # Check Run 생성/업데이트 + self-attestation 마커 emit/verify
    reviews.ts        # PR reviews / CODEOWNERS 승인 실측(octokit) — 검출기 7
  detectors/
    skipped-tests.ts        # 검출기 1
    empty-assertions.ts     # 검출기 2
    env-missing.ts          # 검출기 3
    ignored-failures.ts     # 검출기 4 (실패무시 4-A + 가드 self-attestation/약화 4-B)
    coverage-ratchet.ts     # 검출기 5
    suppression-ratchet.ts  # 검출기 6 (M1 diff 신규 / M2 총량 ratchet)
    baseline-change.ts      # 검출기 7 (baseline 봉인, CODEOWNER fail-closed)
    test-count-ratchet.ts   # #3 하드페일 (실행수 급감 ratchet)
  parse/
    js-ast.ts         # JS/TS 경량 파싱(@babel/parser) — assert/skip/옵셔널env 카운트
    yaml-scan.ts      # 워크플로/스크립트 YAML 스캔(가드 스텝/트리거/if/job-name/입력 추출)
    junit.ts          # JUnit XML / 테스트 요약 파싱(fast-xml-parser) — 실행수 집계
    envrefs.ts        # 코드에서 process.env.X / os.environ[...] 참조 + 옵셔널 관용 추출
    codeowners.ts     # CODEOWNERS 파싱 → baseline 경로의 소유자 계산
  report/
    sarif.ts / annotations.ts / comment.ts
```

각 검출기는 동일 인터페이스(`run(ctx): Promise<Finding[]>`)를 구현한다(Finding: detector·severity·ruleId·message·file?·line?·evidence?).

---

## 4. 검출 로직 상세 (7종 + 하드페일)

공통 원칙:
- **PR 컨텍스트에서는 diff 우선**: 레거시 신호는 warning, "이 PR이 새로 추가/증가시킨" 신호만 error(오탐 최소화).
- **정적 파싱 > 정규식**: JS/TS는 AST, YAML은 파서 기반.
- **더 보수적으로**: 오탐이 개발자를 검출기 off로 몰지 않도록 기본값을 관대하게, error는 명백한 신규 약화에만.

### 4.1 검출기 1 — 스킵/포커스 테스트 (정적 파싱 + diff)
- 변경된 테스트 파일을 `@babel/parser`로 파싱, `.skip`/`.only`/`xit/xdescribe/fit/fdescribe` 탐지. added 라인이면 `error`, 레거시는 `warning`. `.only`는 항상 error.
- Python: **무조건 `skip`만 신호**(warning 기본). **조건부 `skipif`는 기본 침묵**(정당한 호환 매트릭스 소음 방지).

### 4.2 검출기 2 — 빈 어서션 / no-op (경량 assert-카운트 휴리스틱, 오탐 완화)
- AST로 각 테스트 콜백 본문의 assert 신호 수를 센다: `expect(...)` 체인, `assert.*`, chai `.should`/`.to.*`, Python `assert`/`self.assert*`.
- **관대 처리 프리셋(M1 반영, M1 마일스톤 범위에 포함)**: `expect.assertions(n)`/`expect.hasAssertions()`뿐 아니라 **호출 함수 이름이 대문자로 시작하거나 `assert`/`expect`/`check`/`verify`로 시작하면 assert 후보로 관대 처리**. `customAssertions` 설정으로 도메인 헬퍼(`expectUser` 등) 추가. `it.each`/`test.each` 콜백의 공유 헬퍼도 이 관대 규칙으로 커버(m3).
- 판정: assert 신호 0개면 기본 `warning`, 빈 본문/즉시 `return`은 `error`. **PR 신규 테스트에 한해서만 표면화, 레거시는 침묵**(현 설계보다 보수적). `it.todo`는 제외.

### 4.3 검출기 3 — env / 시크릿 누락 (교차 대조, 기본 warning)
- 소스: 코드 참조 키(`process.env.X`/`import.meta.env.X`/`os.environ`/`os.getenv`) ↔ `.env.example` 키 ↔ `ci-env-keys`+`env.knownProvided`.
- 판정(**M2 반영 — 기본 severity를 error에서 warning으로 낮춤**):
  - 코드 참조인데 어디에도 없음 → **기본 `warning`**.
  - `env.required`(사람이 명시한 필수 키, 예 `JWT_SECRET`)가 CI 주입에 없음 → `error`(사람이 명시한 것만 error).
- **광범위 allowlist 프리셋 필수 동봉**: 플랫폼 주입 키(`VERCEL_*`, `CF_*`, `GITHUB_*`, `CI`, `NODE_ENV`, `NEXT_PUBLIC_*` 등)를 프리셋별 기본 allowlist로 제공.
- **옵셔널 참조 강등(AST)**: `process.env.X ?? default`, `process.env.X || ''`, `process.env.X != null ? ...` 등 fallback/guard가 동반된 참조는 **옵셔널로 간주해 info로 강등**.
- 동적 접근(`process.env[var]`)은 info.

### 4.4 검출기 4 — 실패 무시(4-A) + 가드 self-attestation·약화 방지(4-B)

**4-A. 실패 무시 패턴**: `.github/workflows/**`, `package.json`(scripts), `Makefile`, `*.sh`에서 `continue-on-error: true`, `|| true`/`; true`/`exit 0`, `--passWithNoTests`를 탐지. PR 신규는 `error`, 레거시는 `warning`. 정당한 실험 job(`ignoredFailures.allowJobs`)·cleanup 스텝은 완화.

**4-B. 가드 self-attestation + 약화 감시 (경량 — GITHUB_TOKEN+Check Run만)**:

전제(설계에 명시): `pull_request`는 **base 브랜치의 워크플로**를 실행하므로, "가드 스텝이 head diff에 존재하는가"만으로는 자기약화를 못 막는다(공격자가 스텝은 두고 `on:`/`if:`/job-name만 바꿔 required check를 skip=success로 만들면 우회됨). 따라서 4-B는 **"가드가 이 커밋에 대해 실제로 실행되어 success를 리포트했는가"**를 검증한다.

- **(1) self-attestation 마커 emit**: 가드가 실행될 때 `gh/checkrun.ts`가 Check Run output/summary에 `<!-- fcp-attestation sha=<HEAD_SHA> ts=<ISO> run_id=<GH_RUN_ID> -->` 마커를 남긴다. **암호학적 서명 없음**(경량). 위조 방지 서명은 v2.
- **(2) 마커 검증**: `attestation-mode: emit-and-verify`(기본)일 때, 게이트는 **현재 head SHA에 대한 마커가 Check Run에 존재하고 그 `sha`가 현재 head SHA와 일치하는지** 확인한다. 마커가 없거나 SHA 불일치면 `error`("가드가 이 커밋에 대해 실제 실행되지 않았거나 다른 커밋에 대해 실행됨"). 이 검증은 self-attestation이므로 같은 실행 안에서 emit→verify를 수행하되, verify는 **octokit로 이 커밋의 Check Runs 목록을 조회**해 마커 존재를 실측한다(단순 in-process 플래그가 아니라 GitHub이 기록한 사실 기반).
- **(3) 트리거/조건 약화 감시(정적 diff 보조)**: `parse/yaml-scan.ts`가 base↔head로 가드 job의 **`on:` 트리거 변경**(`pull_request` 제거/`workflow_dispatch`화), **`if:` 조건 신규 추가/변경**(예 `if: github.actor != ...`), **job 이름 변경/삭제**, `with.fail-on` 완화(`error`→`warning`→`never`), `with.test-results-glob` 제거를 탐지하면 `error`. 스텝 이동 오탐 방지를 위해 존재 판정은 `.github/workflows/**` 전체 집합 기준.
- 심각도: 위 모두 하드 `error`(`ignoredFailures.guardWeakeningSeverity`, 기본 error). `guardStepNames` 기본 `["false-clean-pass"]`.
- **정직한 경계(§9와 연결)**: 4-B는 "약화를 저지른 PR"과 "가드 미실행"을 **탐지·로깅**하지만 두 가지 근본 한계가 있다 — (1) **마커가 서명 없이 unsigned라 `checks: write`를 가진 임의 스텝이 같은 head SHA 마커를 위조**할 수 있어, 마커 존재는 "위조 불가능한 실행 증명"이 아니라 탐지 보조 신호다(위조 방지는 v2 서명). (2) **skip된 required check를 GitHub이 success로 처리하는 근본 함정**은 Action 혼자 못 막는다. 따라서 4-B는 방어의 유일한 축이 아니며, 최종 강제력은 **브랜치 보호(required status check, 사람 설정)**에 달린다.
- **verify job 분리 (권고, 예시 워크플로에 반영)**: verify를 가드 job과 분리해 **`if: always()`인 독립 job**(alls-green 방식)으로 두어, 가드 job이 제거/skip돼도 verify가 항상 실행되어 마커 부재를 잡도록 예시 워크플로·README에 명시한다. co-located verify는 가드 skip 시 함께 skip되는 순환 문제가 있으므로 예시 워크플로에서 분리형을 권장 기본으로 제시한다.

### 4.5 검출기 5 — 커버리지 임계치 하락 (ratchet)
- 설정 파일 임계치(`coverageThreshold`/`fail_under`) base↔head 감소 시 `error`. 실측 커버리지가 baseline보다 `coverage.tolerance`(기본 0.5%p) 넘게 낮으면 `error`.
- baseline 파일 자체의 diff는 **검출기 7**이 담당(§4.8). 파싱 실패·부분 결과(모노레포 샤딩: total이 baseline 절반 미만이면 병합 누락 의심)는 error 대신 `info`. 커버리지 병합 전제를 README 명시.

### 4.6 검출기 6 — 억제 주석 (diff 신규[M1] + 총량 ratchet[M2], 오탐 완화)
- 패턴: `eslint-disable(-*)?`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore`, `# noqa`, `# pylint: disable`.
- **A. diff 신규(M1)**: PR added 라인의 신규 억제 수를 센다. **기본 `maxNewPerPR=3` + `requireReason=true`**(기본 0은 정당한 억제까지 막을 수 있음). **이유가 달린 억제(`-- 이유`, `@ts-expect-error 이유`)는 카운트 제외가 기본**. error는 "이유 없는 신규 억제가 `maxNewPerPR` 초과"에만.
- **B. 총량 ratchet(M2)**: 전체 억제 총량이 baseline(`.github/false-clean-pass-suppressions.json`)보다 증가 시 `warning`. baseline 무단 수정 방지는 검출기 7.
- `excludePaths` 기본 `fixtures/`·`__mocks__/`.

### 4.7 하드페일 — 실행 테스트 수 급감 ratchet (#3, M5 강화)
- 조건: `test-results-glob`가 주어졌을 때 활성.
- 방법: `parse/junit.ts`가 JUnit XML/JSON 요약에서 **총 실행 테스트 수 = tests - skipped**를 집계.
- **강화**: "0건"만 보는 대신 **base 대비 실행 테스트 수 급감을 ratchet으로 차단**. baseline(`test-count-baseline`, 기본 `.github/false-clean-pass-testcount.json`, 검출기 7 봉인 대상)의 실행수 대비:
  - 실행수 == 0 → `error`(특수 케이스, 하드).
  - 실행수가 baseline 대비 `zeroTests.maxDropPercent`(기본 20%) 넘게 감소 → `error`("테스트 대량 삭제/스킵으로 실행수 급감"). 이로써 "199개 지우고 trivial 1개만 남기기" 우회를 차단.
  - `zeroTests.minRatio`(선택) 지정 시 `실행수/baseline < minRatio`도 error.
  - 결과 파일 없음 → `warning`. 스킵 비율 `zeroTests.skipRatioMax`(기본 90%) 초과 → `warning`.
- **정직한 한계(README 명시)**: JUnit XML은 위조 가능(SpecBench)하고, 4-B 트리거 우회 시 결과 파일 자체가 안 생길 수 있다. 실행수 baseline도 검출기 7으로 봉인하나, 결과 파일 위조는 정적 도구로 완전 차단 불가 → v2(결과 산출 봉인/해시).

### 4.8 검출기 7 — baseline 파일 봉인 (CODEOWNER 승인 실측, fail-closed)
- **정책**: baseline 파일(`.github/false-clean-pass-*.json`: 커버리지·억제·실행수 baseline)은 일반 기능 PR에서 변경 금지. 변경은 baseline 갱신 전용 PR로만.
- **대상 glob**: `.github/false-clean-pass-*.json`(기본, `baselineGuard.paths`로 확장).
- **판정**: base↔head diff에서 대상 파일이 추가·수정·삭제되면 기본 `error`.
- **예외 = CODEOWNER 승인 실측(fail-closed)**: 라벨 단독 예외는 폐기(GitHub이 write 권한 봇의 self-label을 강제로 막지 못함). 대신:
  - `gh/reviews.ts`가 **PR reviews API + `parse/codeowners.ts`로 계산한 baseline 경로의 CODEOWNER**를 대조해, **해당 baseline 경로의 CODEOWNER가 이 PR을 `APPROVED` 했는지**를 실측한다.
  - CODEOWNER approve가 확인되고 **변경이 baseline 파일(+문서)에 한정**되면 error를 `info`로 완화.
  - **fail-closed 기본값**: CODEOWNER 승인을 **확인할 수 없으면(승인 없음/CODEOWNERS 파일 없음/reviews API 접근 실패/데이터 확인 불가 포함) baseline 변경 = `error`**. "확인 불가 = 차단"이 기본.
  - **라벨은 보조 신호로만**: `baselineGuard.exemptLabel`(`baseline-update`)은 로그·코멘트 문구에만 쓰이고, **최종 판정은 CODEOWNER 승인 실측**이 좌우한다. 라벨만으로는 절대 완화되지 않는다.
  - CODEOWNER가 approve했어도 **소스 코드 파일이 함께 변경**되면 예외 미적용(error 유지, "baseline과 코드를 같은 PR에서 섞지 말 것").
- **최초 생성**: baseline 파일이 base에 없던 최초 도입 PR은 `baselineGuard.allowInitialCreate`(기본 true)면 `warning`.
- **README 명시**: baseline 파일 목록, "기능 PR에서 절대 수정 금지", 갱신은 CODEOWNER approve를 받은 별도 PR로만, CODEOWNERS로 baseline 경로 보호가 **강제 전제**(미설정 시 봉인 무의미)임을 기술.

---

## 5. 기술 스택 결정 + 근거

| 결정 | 선택 | 근거 (AGENTS.md "표준 라이브러리/최소 의존성 우선" 준수) |
|---|---|---|
| Action 타입 | **JS Action (Node 20, TypeScript)** | GitHub Action 1급 시민, octokit·toolkit이 JS. 파싱·diff·SARIF·Check Run 마커·reviews API를 코드로 다뤄야 함. |
| 언어 | **TypeScript** | 검출기 로직 타입 안전성 + 자기 테스트 용이. |
| 런타임 | Node 20 (`using: node20`) | GitHub 표준 지원 런타임. |
| GH 연동 | `@actions/core`, `@actions/github`(octokit) | 공식 toolkit. 어노테이션·입력·Check Run·PR reviews·라벨. self-attestation 마커·CODEOWNER 승인 실측에 필수. |
| JS/TS 파싱 | `@babel/parser` | 문법 트리만 필요 → babel로 충분(가볍고 JSX/TS 커버). typescript 풀 로드 회피. **한계 명시**: babel은 타입체크를 안 하므로 모킹 런타임 false-green은 원리적으로 못 잡음(§9). |
| YAML | `yaml` | 워크플로/설정·`on:`/`if:`/job-name 파싱. |
| XML | `fast-xml-parser` | JUnit XML 실행수 집계. |
| 설정 검증 | `zod` | 스키마·기본값·에러 메시지. |
| diff | octokit `repos.compareCommits` + 자체 unified-diff 파서 | GitHub API patch를 직접 파싱해 added/removed·변경 파일 목록 추출. |
| 번들 | `@vercel/ncc` | 단일 `dist/index.js`. |
| 테스트 | `vitest` | 빠르고 TS 네이티브. 자기 리포에 dogfooding(§8). |
| 로컬 컨테이너 | `docker-compose.yml`(Node 20) | 픽스처에 CLI 모드 재현 실행. DB/Redis 불필요(상태 없음). |

- **인프라 요소 근거(왜 지금 필요한가)**:
  - GitHub Action 런타임: 배포 형태 자체(제약 4). 별도 서버 없음.
  - Check Run + PR reviews API(GITHUB_TOKEN): self-attestation 마커·CODEOWNER 승인 실측에 지금 필요. **외부 서명 인프라(KMS·서버·DB)는 도입 안 함(v2)**.
  - SARIF 업로드(codeql-action): findings를 Security 탭에 표준 노출.
  - docker-compose: 로컬 픽스처 재현 실행/테스트. DB·캐시·큐 미포함.
  - Sentry/모니터링 스택: **미포함** — Actions UI 로그 + 상태체크가 지표.

---

## 6. 마일스톤 분할 (MVP = 3개)

각 마일스톤은 독립적으로 완성·테스트 가능하며, 각 기능마다 최소 1개 테스트를 포함한다(AGENTS.md 준수). 각 마일스톤 전후로 `milestone-N: 요약` 커밋.

### 마일스톤 1 — 코어 스캐폴드 + diff 파이프라인 + 정적 검출기 3종 (억제는 diff 신규만)
- **목표**: Action 골격, 설정 로딩, diff 컨텍스트, 검출기 1·2·6(diff 신규만)과 findings→상태체크/어노테이션 렌더 end-to-end.
- **산출물**:
  - `action.yml`, `src/index.ts`, `src/cli.ts`
  - `config/schema.ts`(zod), `config/presets.ts`(node 프리셋 + **검출기 2 assert 헬퍼 관대 처리 프리셋 포함**)
  - `git/diff.ts`, `parse/js-ast.ts`
  - `detectors/skipped-tests.ts`(1), `detectors/empty-assertions.ts`(2 — 헬퍼 관대·신규 한정), `detectors/suppression-ratchet.ts`(6 — **diff 신규 A만, 기본 `maxNewPerPR=3`+`requireReason=true`**)
  - `gh/checkrun.ts`(Check Run 생성; 마커 emit/verify는 M2), `report/annotations.ts`
  - `vitest` 셋업 + `test/fixtures/`
- **완료 기준(DoD)**:
  1. "나쁜" 픽스처에서 3종 검출기 각각 최소 1건 finding(억제는 이유 없는 신규 4개+ 로 error).
  2. "깨끗한" 픽스처 findings 0건(오탐 없음). **커스텀 assert 헬퍼(`expectUser`)·이유 달린 억제는 오탐 안 남**을 테스트로 검증.
  3. diff 모드 added `.only`=error, 레거시=warning 검증.
  4. 각 검출기당 최소 1개 vitest. `fail-on=error` 시 exit non-zero.
  5. 검출기 6은 **diff 신규만**(총량 ratchet 미구현이 M1 범위)임을 코드 주석·테스트로 명시. **dogfooding(자기 리포 CI)은 마일스톤 2 완료 후 활성**(마일스톤 1 단독은 오탐 여지) — DoD에 명시.

### 마일스톤 2 — env(#3) + 실패무시/가드 self-attestation(4-B) + 커버리지·억제 총량 ratchet + baseline CODEOWNER 봉인(7) + 실행수 급감 하드페일(#3)
- **목표**: 검출기 3·4(A+B)·5·7, 억제 총량(6-B), 실행수 급감 하드페일 완성. self-attestation·CODEOWNER fail-closed·실행수 급감 ratchet을 여기서 구현.
- **산출물**:
  - `parse/envrefs.ts`(옵셔널 참조 인식), `parse/yaml-scan.ts`(가드 스텝·`on:`/`if:`/job-name·입력 추출), `parse/junit.ts`, `parse/codeowners.ts`
  - `detectors/env-missing.ts`(3 — 기본 warning·allowlist·옵셔널 강등), `detectors/ignored-failures.ts`(4-A + **4-B self-attestation+트리거/조건/입력 약화**), `detectors/coverage-ratchet.ts`(5), `detectors/baseline-change.ts`(7 — **CODEOWNER 승인 실측 fail-closed**), `detectors/test-count-ratchet.ts`(#3 급감 ratchet)
  - `gh/checkrun.ts` **마커 emit/verify**, `gh/reviews.ts`(PR reviews + CODEOWNER 대조)
  - 검출기 6 **총량 ratchet(6-B)** + baseline 읽기/생성 안내
  - `next`/`python` 프리셋(플랫폼 env allowlist 포함)
- **완료 기준(DoD)**:
  1. env: 코드가 `process.env.JWT_SECRET` 참조하나 어디에도 없음 → **warning**(기본); `env.required`에 있으면 error. `process.env.X ?? d`는 info 강등; `VERCEL_URL` 등 allowlist는 무시 — 오탐 테스트 포함.
  2. 실패무시: 신규 `continue-on-error`/`|| true`/`--passWithNoTests` 각각 error(4-A).
  3. **4-B self-attestation**: 마커 부재/SHA 불일치 시 error; `on:` 트리거 변경·`if:` 신규·job-name 변경·`fail-on` 완화·`test-results-glob` 제거 각각 error; 스텝을 다른 워크플로로 이동한 경우 오탐 없음 — 케이스별 테스트.
  4. 커버리지 80→70 하향 error(5); 부분 커버리지(샤딩)는 info로 강등.
  5. **7 CODEOWNER fail-closed**: baseline 수정 diff에서 (a) CODEOWNER approve 없음→error, (b) CODEOWNER approve+baseline-only→info, (c) approve 있어도 소스 동반→error, (d) reviews API 확인 불가→error — 4케이스 테스트. **라벨만으로는 완화 안 됨**을 명시 테스트.
  6. **실행수 급감 하드페일**: baseline 대비 -20% 초과 감소 error; 0건 error; "199개 삭제+trivial 1개" 시나리오가 급감 ratchet으로 error 되는 테스트.
  7. 억제 총량 증가 warning(6-B).
  8. 각 검출기·하드페일당 최소 1개 vitest.

### 마일스톤 3 — SARIF + PR 코멘트 + 오케스트레이션 통합 + 패키징/문서(정직성)
- **목표**: 7종+하드페일을 단일 상태체크·SARIF·PR 코멘트로 통합. 번들·배포 문서 + **정직한 한계**.
- **산출물**:
  - `report/sarif.ts`(SARIF 2.1.0), `report/comment.ts`(idempotent 마커 코멘트)
  - `core/orchestrator.ts` 최종 통합(7종+하드페일 심각도 집계 → 단일 conclusion + 마커 emit), `fail-on` 정책
  - `@vercel/ncc` 빌드 → `dist/index.js`, `dist/cli.js`
  - `README.md`: 사용법·워크플로 예시·설정 스키마·브랜치 보호 연동 + **Baseline CODEOWNER 봉인 규칙(§4.8)** + **가드 self-attestation·required-check·skip-as-success 함정(§4.4-B, §9)** + **"이 도구가 못 잡는 것"(정적 한계: 모킹 남용·런타임 조건부 스킵·결과 파일 위조)** + **"근접 도구(alls-green/EnricoMi/danger.js/jest-ratchet) 대비 왜 통합인가" 차별성 정직 서술**
  - `.env.example`(이름만), `docker-compose.yml`, `examples/consumer-workflow.yml`
- **완료 기준(DoD)**:
  1. 통합 실행: 여러 위반 섞인 픽스처에서 단일 상태체크 `failure`, SARIF에 모든 ruleId·위치, 코멘트 요약 표 렌더 검증.
  2. SARIF 2.1.0 스키마 검증 통과.
  3. `fail-on=warning`/`never` 정책별 conclusion 분기 테스트.
  4. `dist/` 번들 최신 소스와 동기화(빌드 후 diff 없음) CI 스텝 확인.
  5. README에 실행 방법·브랜치 보호 필수 체크 지정·**Baseline CODEOWNER 봉인**·**self-attestation/required-check 이중 확인**·**"못 잡는 것"·차별성 정직 서술** 포함.

> **전체 완료 기준(DoD)**: 마일스톤 1~3 전체 검증 통과 + README(정직한 한계 포함) + `.env.example` + `docker-compose.yml` + 실행 방법 + 예시 워크플로 + 자기-픽스처 테스트 통과 + `dist/` 번들 동기화 확인 + 사람 최종 확인.

---

## 7. 설정 파일 스키마 예시 (`.github/false-clean-pass.yml`)

```yaml
version: 1
preset: node            # node | next | python | none
failOn: error           # error | warning | never  (with.fail-on 이 우선)
diffMode: pr            # pr(base↔head) | commit(이전 커밋)

testGlobs:
  - "**/*.{test,spec}.{js,ts,jsx,tsx}"
  - "tests/**/*_test.py"

detectors:
  skippedTests:
    enabled: true
    onlyAlwaysError: true
    newSkipSeverity: error
    legacySkipSeverity: warning
    pythonSkipifSilent: true       # 조건부 skipif 침묵 (신규)
  emptyAssertions:
    enabled: true
    emptyBodySeverity: error
    noAssertSeverity: warning
    newTestsOnly: true             # PR 신규 테스트에만 표면화, 레거시 침묵 (신규)
    lenientAssertNames: true       # 대문자 시작 / assert|expect|check|verify 접두 함수를 assert 후보로 (신규)
    customAssertions: ["expectSaga", "expectUser"]
    ignoreTodo: true
  envMissing:
    enabled: true
    unknownSeverity: warning       # 기본 error→warning (신규, M2)
    required: ["JWT_SECRET"]        # 이것만 error (값 아님, 이름만)
    exampleFiles: [".env.example"]
    allowlist: ["NODE_ENV","CI","PATH","HOME","VERCEL_*","CF_*","GITHUB_*","NEXT_PUBLIC_*"]  # (확장, M2)
    optionalFallbackDemote: true   # `?? default`/`|| ''` 동반 참조는 info로 강등 (신규)
    dynamicAccessSeverity: info
  ignoredFailures:
    enabled: true
    newSeverity: error
    legacySeverity: warning
    allowJobs: ["experimental-nightly"]
    allowCleanupCommands: true
    # --- 4-B 가드 self-attestation + 약화 감시 ---
    guardStepNames: ["false-clean-pass"]
    guardWeakeningSeverity: error       # on:/if:/job-name/fail-on/test-results-glob 약화
    attestationMode: emit-and-verify    # emit-and-verify | emit-only | off (with.attestation-mode 우선)
    watchTriggerChanges: true           # on:/if:/job-name 변경 감시
  coverageRatchet:
    enabled: true
    thresholdDropSeverity: error
    tolerance: 0.5
    baselineFile: ".github/false-clean-pass-coverage.json"
    partialResultDemote: true           # total이 baseline 절반 미만이면 info
  suppressionRatchet:
    enabled: true
    maxNewPerPR: 3                       # 기본 0→3 (M3, 변경)
    requireReason: true                  # 기본 false→true, 이유 달린 억제는 카운트 제외 (M3, 변경)
    totalIncreaseSeverity: warning
    baselineFile: ".github/false-clean-pass-suppressions.json"
    excludePaths: ["**/fixtures/**", "**/__mocks__/**"]
  baselineGuard:                         # 검출기 7 (fail-closed)
    enabled: true
    paths: [".github/false-clean-pass-*.json"]
    changeSeverity: error
    requireCodeownerApproval: true       # baseline 경로 CODEOWNER approve 실측
    onApprovalUnverifiable: error        # 확인 불가 시 동작 = fail-closed
    exemptLabel: "baseline-update"       # 보조 신호(로그용)만, 단독 완화 불가 (의미 축소)
    allowInitialCreate: true

zeroTests:                # #3 하드페일 (실행수 급감 ratchet, M5)
  enabled: true
  baselineFile: ".github/false-clean-pass-testcount.json"  # 실행수 baseline (검출기 7 봉인 대상)
  maxDropPercent: 20      # base 대비 실행수 -20% 초과 감소 시 error (신규, M5)
  minRatio: null          # 선택: 실행수/baseline < minRatio 이면 error (신규, M5)
  skipRatioMax: 0.9
```

`with.fail-on`이 `failOn`보다 우선, `with.attestation-mode`가 `detectors.ignoredFailures.attestationMode`보다 우선. `enabled: false`는 개별 검출기 off 토글이나, `baselineGuard`·`zeroTests`·`ignoredFailures.attestationMode`를 끄는 변경 자체가 검출기 7·4-B의 diff 감시 대상이 될 수 있음.

---

## 8. 테스트 전략 (자기 자신에게 픽스처 먹이기)

- **픽스처 리포지토리 방식**: `test/fixtures/` 아래 소형 가짜 프로젝트.
  - `clean/`(위반 0, 오탐 회귀 기준선; **`expectUser` 헬퍼·이유 달린 억제·옵셔널 env 포함해 오탐 안 남 검증**), `skips/`, `empty-assert/`, `env-missing/`(옵셔널·allowlist·required 케이스), `ignored-failures/`, `guard-weakening/`(스텝 제거·`on:` 변경·`if:` 추가·job-name 변경·`fail-on` 완화·`test-results-glob` 제거·**마커 부재/SHA 불일치**·스텝 이동 오탐), `coverage-drop/`(+샤딩 부분결과), `suppressions/`(신규+이유+총량), `baseline-change/`(**CODEOWNER approve 4케이스: 없음/approve+baseline-only/approve+코드동반/확인불가**), `test-count-drop/`(0건·-20%급감·trivial 1개 우회 시나리오).
- **diff/컨텍스트 주입**: `git/diff.ts`·`gh/reviews.ts`·`gh/checkrun.ts`는 주입 가능한 provider 인터페이스로 설계. 테스트는 before-after 파일 쌍으로 unified diff, PR reviews·Check Run 마커·라벨을 목으로 주입(실 API 불필요).
- **골든 파일**: findings JSON·SARIF 스냅샷 회귀.
- **dogfooding**: **M2 완료 후** 자기 리포 CI에 자기 Action을 걸어 `false-clean-pass` 체크 초록 확인. baseline 파일은 검출기 7 대상이므로 CODEOWNER approve 별도 PR로만 갱신.
- **오탐 회귀 게이트**: `clean` 픽스처 findings 1건이라도 CI fail(오탐 0 유지).

---

## 9. 리스크 & 완화

| 리스크 | 근거 | 완화 |
|---|---|---|
| **가드 자기약화 — 트리거/조건 우회** | `pull_request`는 base 워크플로 실행 + skip된 required check는 GitHub이 success 처리 | 4-B를 **self-attestation(마커 존재+head SHA 일치 실측)**으로 재정의 + `on:`/`if:`/job-name 변경 감시. **정직한 경계**: skip-as-success 근본 함정은 Action 혼자 못 막음 → **required status check 지정 + self-attestation 이중 확인**(사람 브랜치 보호 설정)으로만 갭이 좁혀짐. 위조 방지 서명은 v2. |
| **baseline 봉인 — self-label 우회** | GitHub이 write 봇의 self-label을 강제로 못 막음 | 예외를 **CODEOWNER 승인 실측**으로 전환 + **fail-closed**(확인 불가=차단). 라벨은 보조 신호로만. §10.3에 CODEOWNERS baseline 경로 보호를 **강제 전제**로 승격. |
| **하드페일 우회 — trivial 1개** | 199개 삭제+`expect(true).toBe(true)` 1개면 실행수=1로 통과 | "0건"에서 **실행수 급감 ratchet**(base 대비 -20% 초과 error)로 강화. 실행수 baseline도 검출기 7 봉인. |
| **오탐이 개발자를 off로 몬다** (M1·M2·M3) | 공유 헬퍼·플랫폼 env·정당한 억제 | 검출기 2 헬퍼 관대·신규 한정; 검출기 3 기본 warning·allowlist·옵셔널 강등; 검출기 6 `maxNewPerPR=3`+`requireReason`. `clean` 픽스처 오탐 0 게이트. |
| **차별성 과대평가** | 조각들은 성숙 도구로 대체 가능 | 차별성 서사를 **오케스트레이션 + 자기약화 방지(4-B/7)**로 정직하게 좁힘. README "왜 통합인가"·"못 잡는 것" 섹션. 4-B/7 실효가 곧 해자. |
| **정적/diff의 원리적 한계** | babel은 타입체크 안 함; 모킹·런타임 스킵·결과 위조 | README "이 도구가 못 잡는 것"에 정직히 명시. 런타임 false-green·결과 산출 봉인은 v2. |
| **강제력 부재** | 진짜 차단은 서버측 브랜치 보호 | required status check 지정 + self-attestation 결합 절차 README·§10 명시. |
| **번들(dist) 표류** | JS Action은 커밋된 dist 사용 | CI에서 `ncc build` 후 diff 없음 검사(M3 DoD 4). |
| **GITHUB_TOKEN 권한** | 코멘트/체크런/reviews API 필요 | `permissions: { pull-requests: write, checks: write, contents: read }` 최소 권한 명시. fork PR 제약 시 어노테이션·SARIF 폴백. |

---

## 10. "사람이 준비할 것" 목록

> 인프라·시크릿 경계 규칙: 아래는 **요청 목록**이며 에이전트가 직접 수행하지 않는다. 실제 값·계정 생성·권한 부여는 사람이 한다. 시크릿 값은 이 문서·코드에 절대 기록하지 않는다.

### 10.1 외부 자원 / 계정
1. **GitHub 저장소 생성** (public 권장 — Marketplace 게시·오픈소스 Action 배포용). 예: `false-clean-pass-ci-guard`.
2. **GitHub Marketplace 게시 자격**: 2FA 활성화 + Marketplace 게시 동의(사람이 GitHub UI). MVP 검증까지는 게시 없이 직접 참조 가능.
3. **릴리스 태그 정책 결정**: `v1` 이동 태그 운영. 사람이 승인.

### 10.2 시크릿 / 토큰 (이름만 — 값 금지)
- `GITHUB_TOKEN`: **발급 불필요**. 소비자 워크플로에서 `${{ secrets.GITHUB_TOKEN }}` 참조. self-attestation 마커·CODEOWNER 승인 실측·코멘트에 사용. 사람이 할 일은 워크플로 최소 권한 부여뿐.
- 이 도구는 별도 API 키·DB 자격증명·서드파티 토큰이 **필요 없다**(상태 없는 정적 검사기, 외부 서명 인프라는 v2). 추가 시크릿 발급 요청 없음.

### 10.3 저장소 설정 / 권한 (사람이 GitHub UI에서) — **가드 실효의 강제 전제**
1. **브랜치 보호 규칙**: 보호 브랜치(예 `main`)에 **required status check = `false-clean-pass`** 지정. + **self-attestation 이중 확인**(가드가 이 커밋에 대해 success 마커를 남겼는지)을 신뢰하도록 운영. (skip된 required check가 success로 처리되는 GitHub 함정을 좁히는 핵심 — §4.4-B, §9)
2. **워크플로 권한**: `GITHUB_TOKEN` 기본 read + 소비자 워크플로에서 `pull-requests: write`, `checks: write`, `contents: read` 명시.
3. **CODEOWNERS로 baseline 경로 보호 (강제 전제, 권고 아님)**: `CODEOWNERS`에 `.github/false-clean-pass-*.json`(및 `.github/false-clean-pass.yml`·`.github/workflows/**`)을 **사람/메인테이너 소유로 등록**하고, 브랜치 보호에서 **CODEOWNER 리뷰 승인 필수(Require review from Code Owners)** 를 켠다. **이 설정이 없으면 검출기 7의 baseline 봉인은 무의미**(가드가 approve를 실측할 대상 자체가 없음). baseline 갱신 PR은 **baseline 경로 CODEOWNER의 approve 필수** — 이것이 봉인의 유일한 정당 예외 경로다.
4. **`baseline-update` 라벨(선택, 보조)**: 생성해도 되나 **봉인 완화 효력 없음**(최종 판정은 CODEOWNER approve 실측). 운영 표식 용도로만.
5. **Code scanning(SARIF) 활성화**: Security 탭에서 사용 설정(SARIF 표시용).

### 10.4 배포 경계
- **로컬 저장소에 git remote 준비**: 프로젝트 로컬 저장소에는 remote가 없다. 사람이 GitHub 저장소를 만든 뒤 `git remote add origin <url>` 로 연결해야 에이전트가 push할 수 있다(값·인증은 사람 몫).
- "배포"는 **git push + GitHub 릴리스 태그**까지가 에이전트 권한. Marketplace 실제 게시는 사람이 GitHub UI에서 최종 수행. push 전 디스코드 승인.
- 프로덕션 반영은 **PR 방식 권장**: 에이전트가 브랜치 push → PR 생성 → 사람이 프리뷰 확인 후 머지.

---

## 11. 의존성 목록 (오케스트레이터가 설치)

프로젝트 폴더에서 사람 승인 후 오케스트레이터가 직접 설치한다(Codex 샌드박스 네트워크 제약 대비).

### 런타임 의존성 (`dependencies`)
- `@actions/core` — 입력/출력/어노테이션/로그
- `@actions/github` — octokit(diff, Check Run 마커, PR reviews, 라벨, 코멘트)
- `@babel/parser` — JS/TS 경량 AST 파싱
- `yaml` — 워크플로/설정·`on:`/`if:`/job-name YAML 파싱
- `fast-xml-parser` — JUnit XML 실행수 집계
- `zod` — 설정 스키마 검증

### 개발 의존성 (`devDependencies`)
- `typescript`, `@types/node`
- `vitest` — 테스트 러너
- `@vercel/ncc` — Action 단일 번들 빌드
- `@babel/types` — AST 노드 타입
- (선택) `ajv` + SARIF JSON 스키마 — SARIF 스키마 검증 테스트용

> CODEOWNERS 파싱은 별도 라이브러리 없이 자체 구현(`parse/codeowners.ts`)으로 표준 라이브러리 우선 원칙 준수(글로브 매칭은 이미 diff 파일 매칭용으로 두는 경량 매처 재사용).

### 설치 명령 (참고)
```bash
npm i @actions/core @actions/github @babel/parser yaml fast-xml-parser zod
npm i -D typescript @types/node vitest @vercel/ncc @babel/types ajv
```

### docker-compose.yml (로컬 개발/테스트용)
```yaml
# 상태 없는 정적 검사기이므로 DB/Redis/큐 불필요.
# 유일한 목적: Node 20 환경에서 픽스처에 CLI 모드로 도구를 재현 실행.
services:
  dev:
    image: node:20
    working_dir: /app
    volumes:
      - .:/app
    command: sh -c "npm ci && npm test"
```
> 왜 지금 필요한가: 로컬에서 Action을 CLI 모드로 픽스처 리포에 재현 실행/테스트하기 위함. 상태가 없어 DB·Redis·큐 컨테이너는 미포함.

---

## 부록 A — 소비자 워크플로 예시 (`examples/consumer-workflow.yml`)

```yaml
name: false-clean-pass
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]  # 라벨/리뷰 반영 위해
permissions:
  contents: read
  pull-requests: write      # 코멘트 + PR reviews 조회(CODEOWNER 승인 실측)
  checks: write             # Check Run + self-attestation 마커
  security-events: write    # SARIF 업로드용
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # base↔head diff
      - run: npm ci && npm test -- --reporter=junit --outputFile=junit.xml
      - uses: toaded-git/false-clean-pass-ci-guard@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          test-results-glob: "junit.xml"        # 제거하면 4-B가 error
          coverage-summary: "coverage/coverage-summary.json"
          ci-env-keys: "DATABASE_URL,JWT_SECRET" # 값 아님, 키 이름만
          fail-on: error                          # 완화하면 4-B가 error
          attestation-mode: emit-and-verify       # 가드 실행 여부 self-attestation
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: false-clean-pass.sarif
```
> 브랜치 보호에서 이 job의 Check Run(`false-clean-pass`)을 required status check로 지정하고, CODEOWNERS로 `.github/false-clean-pass-*.json`을 보호해야(§10.3) 가드가 실효를 갖는다.
