# 설계서: "false clean pass" 방지 CI 가드레일 봇

프로젝트명: `false-clean-pass-ci-guard`
작성일: 2026-07-11
배포물: **단일 GitHub Action** (composite/JS Action, SaaS 아님)
구현 주체: Codex (이 문서는 모호함 없이 그대로 구현 가능해야 함)

---

## 1. 개요 / 문제 정의 / 이 도구가 막는 것

AI 코딩 에이전트가 코드를 대량 생성하면서 "CI 초록불(그린)"의 신뢰성이 무너지고 있다. CI는 통과했지만 실제로는 테스트가 스킵/미실행됐거나, 어서션이 비어 있거나, 필수 env/시크릿이 CI에 없어 코드가 실제로는 돌지 않거나, 워크플로에 `|| true`·`continue-on-error`가 끼어 실패가 삼켜지거나, 커버리지 임계치를 몰래 낮추거나, `eslint-disable`·`# type: ignore` 같은 억제 주석을 늘려 경고를 지우거나, 가드 자신의 baseline 파일·검사 스텝을 몰래 약화시킨 상태를 "false clean pass(거짓 통과)"라 부른다. 이 도구는 **PR 단위로 위 7종의 검증 우회·약화 신호를 하나의 GitHub Action(= 단일 상태체크 1개)으로 통합 탐지**하여, 배포 전에 시끄럽게 실패시키고 어노테이션·SARIF·PR 코멘트로 근거를 남긴다. 기존 시장은 스킵 린트룰·뮤테이션 테스트·시크릿 스캐너·테스트 diff 리포터로 파편화되어 있고 아무도 이들을 한 번에 붙이지 않으며, 특히 "가드 자체를 약화시키는 diff"를 막는 도구가 없다는 빈틈을 노린다.

---

## 2. MVP 범위 (포함/제외 경계)

승인된 범위: 리서치 결론의 노릴 빈틈 중 **#1(6종 검증을 하나의 상태체크로 통합)** + **#3(env 누락 탐지 + "실행 테스트 0건인데 통과" 하드 페일)** 을 기본으로 하되, 사람 조건부 승인에 따라 **#2 "설정 봉인 메타 계층"의 일부(baseline 파일 변경 감지 + 가드 스텝/설정 약화 탐지)를 MVP로 앞당겨** 검출기 7종으로 확장한다.

### 2.1 포함/제외 경계표

| 영역 | 항목 | MVP 포함 | 근거 / 비고 |
|---|---|:---:|---|
| 통합 게이트 (#1) | 7종 검출기를 단일 Action·단일 상태체크로 오케스트레이션 | 포함 | 승인 범위 핵심 |
| 검출기 1 | 테스트 스킵: `.skip` / `xit` / `it.only` / `describe.only` / `fit` / `xdescribe` / `test.only` | 포함 | 정적 파싱 + PR diff |
| 검출기 2 | 빈 어서션 / no-op 테스트 (assert 0건) — **경량 assert-카운트 휴리스틱** | 포함 | 뮤테이션 테스팅은 제외(제약 3), 휴리스틱 채택 |
| 검출기 3 | env / 시크릿 누락 (`.env.example` ↔ CI env ↔ 코드 `process.env.X`/`os.environ` 대조) | 포함 | #3 |
| 검출기 4 | 실패 무시: `\|\| true` / `continue-on-error: true` / `--passWithNoTests` / `exit 0` + **가드 스텝 제거 / `fail-on` 완화 / `test-results-glob` 제거** (워크플로·스크립트 diff) | 포함 | #1 + 가드 자기약화 방지 |
| 검출기 5 | 커버리지 임계치 하락 (ratchet: 커밋된 baseline 대비 숫자 감소) | 포함 | #1 |
| 검출기 6 | 억제 주석 증가: `eslint-disable(-*)?` / `@ts-ignore` / `@ts-expect-error` / `# type: ignore` / `# noqa` — **diff 신규 증가(M1)** + **총량 ratchet(M2)** | 포함 | #1 (M1/M2 분할 구현) |
| 검출기 7 | **baseline 파일 변경 감지**: `.github/false-clean-pass-*.json`이 PR diff에서 변경되면 무조건 error (별도 PR 정책) | 포함 | #2 일부를 MVP로 이동(조건부 승인) |
| 하드 페일 (#3) | "실행된 테스트 수 == 0 인데 그린" → 무조건 fail (JUnit XML / 테스트 요약 JSON 파싱) | 포함 | #3 |
| 출력 | 단일 상태체크(pass/fail) + GitHub 어노테이션 + SARIF 업로드 + PR 코멘트 요약 | 포함 | 강제력은 브랜치 보호와 결합(§9) |
| 설정 | `.github/false-clean-pass.yml` 스키마 (임계치·on/off 토글·프리셋) | 포함 | §7 |
| 언어 | JS/TS 우선, Python 부분 지원(env·억제주석·스킵 정규식) | 포함 | 리서치: JS/TS 커버 쉬움, 다언어는 점진 |
| **메타 우회 방지 (#2) 나머지** | 가드 설정 해시 lockfile 봉인, 워크플로 job 제거 탐지, required-check 대조, CODEOWNERS 강제 | **제외 → v2** | 제약 2 (일부만 MVP 이동) |
| **뮤테이션 테스팅** | Stryker 등 실제 mutant 실행 | **제외 → v2** | 제약 3 (경량 휴리스틱으로 대체) |
| 훅 우회(`--no-verify`, `HUSKY=0`) 탐지 | reflog/커맨드 감사 | **제외 → v2** | 승인 6종 밖 |
| 다언어 전면 지원(Go/Rust/Java) | | **제외 → v2** | 유지보수 부담(리서치 리스크) |
| SaaS / 대시보드 / DB | | **제외** | 단일 Action(제약 4) |

### 2.2 v2로 분리한 항목 (설계만 남기고 구현 안 함)
- **#2 메타 계층 (나머지)**: (a) 가드 설정(`.github/false-clean-pass.yml`, 워크플로)의 해시를 lockfile(`.github/false-clean-pass.lock`)에 봉인하고 PR diff에서 무단 약화(임계치 하향·job 삭제)를 탐지. (b) `required status checks` 목록과 실제 실행 job 대조. (c) CODEOWNERS 강제 권고.
  - **[MVP로 이동됨]** baseline 파일(`.github/false-clean-pass-*.json`) 변경 diff 감지 → 검출기 7로 MVP 편입(§4.8). baseline 갱신은 별도 PR 전용으로 정책화.
  - **[MVP로 이동됨]** 가드 스텝(`false-clean-pass` 참조) 제거 / `fail-on` 완화 / `test-results-glob` 제거 diff 감지 → 검출기 4로 MVP 편입(§4.4).
- **뮤테이션 테스팅 옵트인 모드**: 휴리스틱이 "의심"으로 표시한 파일에 한해 Stryker를 선택 실행.
- **훅 우회 신호**: CI 이벤트/reflog에서 `--no-verify`·`HUSKY=0`·force-push 흔적 탐지.
- **다언어 규칙팩**: Go(`t.Skip`, `//nolint`), Rust(`#[ignore]`, `#[allow]`), Java(`@Disabled`) 규칙 추가.

---

## 3. 아키텍처

### 3.1 실행 모델 (GitHub Action)

**타입**: JavaScript(Node 20) GitHub Action. `action.yml` + 번들된 `dist/index.js`(ncc). composite가 아니라 JS Action인 이유는 diff 파싱·정적 파싱·SARIF 생성 로직이 복잡해 코드로 다뤄야 하기 때문.

**트리거(사용자 워크플로에서 지정, Action 자체는 이벤트 비의존)**:
- `pull_request` (opened, synchronize, reopened) — 주 대상. base↔head diff 확보.
- `push` (선택) — diff 기반 검출기는 이전 커밋과 비교, ratchet은 baseline 파일 사용.

**입력(`with:`) 및 환경**:
| 입력 | 필수 | 기본 | 설명 |
|---|:---:|---|---|
| `config-path` | N | `.github/false-clean-pass.yml` | 설정 파일 경로 |
| `test-results-glob` | N | `` (빈값) | JUnit XML/JSON 테스트 결과 파일 glob. 있으면 "테스트 0건" 하드페일 활성 |
| `coverage-summary` | N | `` | 커버리지 요약 파일 경로(예: `coverage/coverage-summary.json`) |
| `ci-env-keys` | N | `` | CI에 실제 주입된 env 키 이름 목록(쉼표 구분, **값 아님**). env 누락 대조용 |
| `fail-on` | N | `error` | `error` \| `warning` \| `never`. 어느 심각도부터 상태체크를 fail 시킬지 |
| `sarif-output` | N | `false-clean-pass.sarif` | SARIF 파일 출력 경로 |
| `comment-mode` | N | `update` | `update` \| `new` \| `off`. PR 코멘트 동작 |
| `github-token` | Y | — | `${{ secrets.GITHUB_TOKEN }}` 참조. diff·코멘트·체크런 API용 |

> 시크릿은 문서/코드에 값으로 쓰지 않는다. `github-token`은 워크플로에서 `${{ secrets.GITHUB_TOKEN }}` 참조로만 전달한다. `ci-env-keys`는 **키 이름 목록만** 받고 값은 절대 받지 않는다.

**출력(`outputs`)**:
| 출력 | 설명 |
|---|---|
| `result` | `pass` \| `fail` |
| `error-count` / `warning-count` | 심각도별 findings 개수 |
| `sarif-path` | 생성된 SARIF 경로 |

**부수효과(side effects)**:
1. **상태체크 1개**: `false-clean-pass` 이름의 Check Run 생성(conclusion = success/failure/neutral). 이것이 브랜치 보호에서 required로 지정될 단일 게이트.
2. **어노테이션**: 각 finding을 파일·라인에 GitHub annotation으로.
3. **SARIF**: `github/codeql-action/upload-sarif`로 업로드하면 Security 탭에 표시(업로드 자체는 사용자 워크플로 스텝 책임, 우리는 SARIF 파일만 생성).
4. **PR 코멘트**: 심각도별 요약 표 1개(마커 주석으로 idempotent 업데이트).
5. **프로세스 exit code**: `fail-on` 정책 위반 시 non-zero(로컬 CLI 실행 시에도 게이트 동작).

### 3.2 내부 모듈 구성

```
src/
  index.ts            # Action 엔트리: 입력 파싱 → orchestrator 실행 → 출력 렌더
  cli.ts              # 로컬 CLI 엔트리(Action 없이 `node dist/cli.js` 실행, 테스트/개발용)
  config/
    schema.ts         # 설정 zod 스키마 + 기본값 + 프리셋 병합
    presets.ts        # node / next / python 프리셋 정의
  core/
    orchestrator.ts   # 7개 검출기 + 하드페일 실행, findings 취합, 심각도 판정
    types.ts          # Finding, Severity, DetectorContext, DetectorResult 타입
    context.ts        # DetectorContext 구성: diff, changed files, config, ci-env-keys
  git/
    diff.ts           # base↔head diff 취득(octokit compare) + 파일별 added/removed 라인
  detectors/
    skipped-tests.ts        # 검출기 1
    empty-assertions.ts     # 검출기 2
    env-missing.ts          # 검출기 3
    ignored-failures.ts     # 검출기 4 (실패무시 + 가드 스텝/설정 약화)
    coverage-ratchet.ts     # 검출기 5
    suppression-ratchet.ts  # 검출기 6 (M1: diff 신규 / M2: 총량 ratchet)
    baseline-change.ts      # 검출기 7 (baseline 파일 변경 감지)
    zero-tests.ts           # #3 하드페일
  parse/
    js-ast.ts         # JS/TS 경량 파싱(@babel/parser) — assert/skip 카운트
    yaml-scan.ts      # 워크플로/스크립트 YAML 스캔 (가드 스텝/입력 추출 포함)
    junit.ts          # JUnit XML / 테스트 요약 파싱(fast-xml-parser)
    envrefs.ts        # 코드에서 process.env.X / os.environ[...] 참조 추출
  report/
    sarif.ts          # findings → SARIF 2.1.0
    annotations.ts    # findings → GitHub annotation
    comment.ts        # findings → PR 코멘트 마크다운
    checkrun.ts       # Check Run 생성/업데이트
```

각 검출기는 동일 인터페이스를 구현한다:
```ts
export interface Detector {
  id: string;                              // 예: "skipped-tests"
  run(ctx: DetectorContext): Promise<Finding[]>;
}
export interface Finding {
  detector: string;
  severity: 'error' | 'warning' | 'info';
  ruleId: string;                          // SARIF ruleId
  message: string;
  file?: string;
  line?: number;
  evidence?: string;                       // diff 스니펫 등
}
```

---

## 4. 검출 로직 상세 (7종 + 하드페일)

공통 원칙:
- **PR 컨텍스트에서는 diff 우선**: 기존 코드의 레거시 `.skip`으로 전체를 막지 않는다. **"이 PR이 새로 추가/증가시킨" 신호**만 error로, 총량은 warning으로 다룬다(오탐 최소화).
- **정적 파싱 > 정규식**: 문자열 리터럴·주석 안의 오탐을 줄이기 위해 JS/TS는 AST, YAML은 파서 기반. 정규식은 보조 신호로만.
- 각 검출기는 설정으로 `on/off` 및 임계치 조정 가능. **단, 검출기 7(baseline 변경)의 error 판정은 하드하며 baseline 갱신은 별도 PR로만 허용한다(§4.8).**

### 4.1 검출기 1 — 스킵/포커스 테스트 (정적 파싱 + diff)
- 방법: 변경된 테스트 파일(`**/*.{test,spec}.{js,ts,jsx,tsx}`, 설정 override 가능)을 `@babel/parser`로 파싱, `CallExpression`에서 `it/test/describe`의 멤버 접근 `.skip`/`.only` 및 식별자 `xit/xdescribe/fit/fdescribe` 탐지.
- diff 대조: 해당 노드의 라인이 PR에서 **added 라인**이면 `error`, 파일에 이미 존재(레거시)면 `warning`.
- Python: `pytest.mark.skip`/`@pytest.mark.skipif`/`@unittest.skip`은 정규식 보조 탐지(warning 기본).
- 오탐 최소화: 문자열/주석 내 `.skip` 무시(AST가 자연 처리). `.only`는 항상 error(포커스는 CI에서 다른 테스트를 건너뛰게 만듦).

### 4.2 검출기 2 — 빈 어서션 / no-op 테스트 (경량 assert-카운트 휴리스틱)
- 방법: AST로 각 테스트 콜백(`it/test`의 함수 인자) 본문을 순회하여 **assert 신호 개수**를 센다. assert 신호 = `expect(...)` 체인 호출, `assert.*(...)`, `chai` `.should`/`.to.*`, Python `assert` 문/`self.assert*`.
- 규칙: 테스트 본문에 실행문은 있으나 assert 신호가 **0개**면 `warning`(기본), 설정으로 `error` 승격 가능. 콜백이 비어 있거나 즉시 `return`만 있으면 `error`.
- diff 대조: PR에서 새로 추가된 테스트가 assert 0개면 우선순위 높임.
- 오탐 최소화: `expect.assertions(n)`/`expect.hasAssertions()` 존재 시 assert 있는 것으로 간주. 스냅샷(`toMatchSnapshot`)·`await expect(...).rejects` 등도 assert로 카운트. `todo` 테스트(`it.todo`)는 대상 제외. 커스텀 assert 헬퍼 이름을 설정(`customAssertions`)으로 등록 가능.

### 4.3 검출기 3 — env / 시크릿 누락 (교차 대조) — #3
- 세 소스를 대조한다:
  1. **코드가 요구하는 키**: `parse/envrefs.ts`가 소스에서 `process.env.X`, `import.meta.env.X`, `os.environ["X"]`/`os.environ.get("X")`, `os.getenv("X")` 참조를 추출.
  2. **선언된 키**: `.env.example`(설정으로 경로 목록화)에 나열된 키.
  3. **CI에 실제 주입된 키**: `ci-env-keys` 입력(키 이름 목록) + 설정의 `env.knownProvided`.
- 판정:
  - 코드가 참조하는데 `.env.example`에도 없고 CI에도 없음 → `error` ("코드가 요구하지만 어디에도 선언/주입 안 됨").
  - `.env.example`엔 있으나 CI 주입 목록에 없음 → `warning`(테스트가 실제로는 안 돌 수 있음).
  - `env.required`(설정에 명시한 필수 키, 예: `JWT_SECRET`)가 CI 주입 목록에 없음 → `error`.
- "약한 시크릿" 검사: **값을 다루지 않으므로** MVP에서는 하지 않는다(값 검사는 시크릿 노출 위험). 필수 키 **존재 여부**만 본다.
- 오탐 최소화: 동적 접근(`process.env[variable]`)은 키를 특정 못 하므로 info로만. allowlist(`env.ignore`)로 `NODE_ENV`·`CI`·`PATH` 등 런타임 기본 제공 키 제외. 기본 allowlist 프리셋 제공.

### 4.4 검출기 4 — 실패 무시 패턴 + 가드 자기약화 방지 (워크플로/스크립트 diff)
- 대상 파일: `.github/workflows/**/*.yml|yaml`, `package.json`(scripts), `Makefile`, `*.sh`.
- **A. 실패 무시 패턴 (기존)**:
  - YAML 파싱: 워크플로에서 `continue-on-error: true`(step/job)와 `run:` 문자열 내 `|| true`, `; true`, `exit 0`(무조건 성공화), 테스트 러너 플래그 `--passWithNoTests`/`--pass-with-no-tests`를 탐지.
  - diff 대조: PR에서 **새로 추가된** `continue-on-error: true`/`|| true`/`--passWithNoTests`는 `error`. 기존 존재분은 `warning`.
  - `package.json` scripts와 셸 스크립트도 문자열 스캔(정규식)으로 `|| true`/`--passWithNoTests` 탐지.
- **B. 가드 자기약화 방지 (신규 — 조건부 승인)**: `parse/yaml-scan.ts`가 워크플로에서 **본 Action(`false-clean-pass`)을 참조하는 스텝**(예: `uses:` 값에 `false-clean-pass-ci-guard` 포함)을 식별하고, base↔head diff로 다음 변경을 탐지한다. 아래 3가지는 PR diff에 있으면 **error**:
  1. **가드 스텝 제거**: base 워크플로에 존재하던 `false-clean-pass` 참조 스텝(job)이 head에서 사라짐 → error ("가드 검사 스텝 제거").
  2. **`fail-on` 임계치 완화**: 동일 가드 스텝의 `with.fail-on` 값이 엄격→느슨(`error`→`warning`, `error`→`never`, `warning`→`never`)으로 변경 → error ("게이트 임계치 완화"). 반대(강화) 방향은 통과.
  3. **`test-results-glob` 제거**: 동일 가드 스텝의 `with.test-results-glob`가 base에 있었는데 head에서 삭제/공란화 → error ("테스트 0건 하드페일 무력화"). 이는 검출기 3(#3 하드페일)을 우회하는 대표 수법.
  - 심각도 매핑: 세 항목 모두 하드 `error`(설정 `ignoredFailures.guardWeakeningSeverity`로만 조정, 기본 error). 정당한 가드 스텝 이름/경로는 설정 `ignoredFailures.guardStepNames`(기본 `["false-clean-pass"]`)로 식별.
- 오탐 최소화: 주석 라인 제외. `continue-on-error`가 `matrix`/명시적으로 정당한 실험 job(설정 `ignoredFailures.allowJobs`에 등록)이면 스킵. `|| true`가 정리(cleanup) 스텝(설정으로 등록)이면 완화. 가드 스텝을 **다른 워크플로 파일로 이동**한 경우 오탐을 막기 위해, 스텝 존재 여부는 **워크플로 파일 단위가 아니라 전체 `.github/workflows/**` 집합 기준**으로 판정(head 전체에서 가드 참조가 하나라도 남아 있으면 "제거"로 보지 않음).

### 4.5 검출기 5 — 커버리지 임계치 하락 (ratchet)
- 두 모드:
  - **설정 파일 임계치 하향**: `jest.config`/`vitest.config`/`.nycrc`/`pyproject.toml`의 `coverageThreshold`·`fail_under` 숫자를 base↔head로 비교, **감소하면** `error`.
  - **실측 커버리지 하락**: `coverage-summary` 입력이 주어지면 현재 전체 커버리지%를 읽어 저장된 baseline(`.github/false-clean-pass-coverage.json`)보다 `coverage.tolerance`(기본 0.5%p) 넘게 낮으면 `error`.
- **baseline 파일 자체의 diff는 검출기 7이 담당한다**(§4.8). 즉 검출기 5는 "실측 값 vs baseline" 비교만 하고, baseline 파일이 이 PR에서 수정됐는지는 검출기 7이 별도로 error 처리한다.
- diff 우선: 임계치 하향은 순수 diff 숫자 비교라 오탐이 거의 없음.
- 오탐 최소화: 파일 이동/설정 포맷 변경으로 숫자를 못 읽으면 error 대신 `info`(파싱 실패 표시). tolerance로 반올림 흔들림 흡수.

### 4.6 검출기 6 — 억제 주석 증가 (diff 신규[M1] + 총량 ratchet[M2])
- 대상 패턴: `eslint-disable`, `eslint-disable-next-line`, `eslint-disable-line`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore`, `# noqa`, `# pylint: disable`.
- **A. diff 신규 증가 (마일스톤 1 구현)**: PR diff의 **added 라인**에서 위 패턴의 신규 등장 수를 센다. `suppression.maxNewPerPR`(기본 0) 초과 시 `error`. diff 우선이라 레거시 억제는 건드리지 않음(오탐 최소화 핵심).
- **B. 총량 ratchet (마일스톤 2 구현)**: 저장소 전체 억제 주석 총량을 세어 baseline(`.github/false-clean-pass-suppressions.json`)보다 증가하면 `suppression.totalIncreaseSeverity`(기본 `warning`). baseline 파일의 읽기/생성 안내 로직은 M2에서 추가한다. (baseline 파일 자체의 무단 수정 방지는 검출기 7이 담당 — §4.8.)
- 오탐 최소화: 억제에 사유가 붙은 경우(`eslint-disable ... -- 이유`, `@ts-expect-error 이유`)는 설정 `suppression.requireReason=true`일 때 카운트 완화. 테스트 픽스처 디렉토리(`fixtures/`, `__mocks__/`)는 기본 제외.

### 4.7 하드페일 — "실행 테스트 0건인데 그린" (#3)
- 조건: `test-results-glob`가 주어졌을 때만 활성.
- 방법: `parse/junit.ts`가 JUnit XML(`<testsuite tests="..">`) 또는 지원 JSON 요약을 파싱해 **총 실행 테스트 수 = tests - skipped**를 계산.
- 판정: 실행 수 == 0 이면 무조건 `error`(설정으로 끌 수 없는 하드페일, 단 `zeroTests.enabled=false`로 명시적 비활성만 허용). 결과 파일 자체가 없으면 `warning`("테스트 결과 리포트를 못 찾음 → 진짜 실행됐는지 알 수 없음").
- 오탐 최소화: `skipped` 대량(예: 전체의 `zeroTests.skipRatioMax`=90% 초과 스킵)도 `warning`으로 표면화.

### 4.8 검출기 7 — baseline 파일 변경 감지 (조건부 승인, MVP 편입)
- **정책**: 가드가 신뢰하는 baseline 파일 `.github/false-clean-pass-*.json`(커버리지 baseline·억제주석 baseline 등)은 **일반 기능 PR에서 절대 변경되어서는 안 되며, 갱신은 오직 baseline 갱신 전용 PR로만** 수행한다. 이는 v2 "설정 봉인 메타 계층"의 일부를 MVP로 앞당긴 것으로, 에이전트가 baseline을 몰래 낮춰 ratchet(검출기 5·6)을 무력화하는 것을 차단한다.
- **대상 파일 glob**: `.github/false-clean-pass-*.json` (기본값). 설정 `baselineGuard.paths`로 확장 가능(예: 추가 baseline 경로). 정확히 이 파일들의 diff만 본다.
- **방법**: base↔head diff에서 대상 glob에 해당하는 파일이 **추가·수정·삭제(어떤 변경이든)**되면 **무조건 `error`**를 낸다(라인 단위가 아니라 파일 변경 자체가 신호). 검출기 5·6의 실측 비교와 독립적으로 동작한다.
- **별도 PR 예외**: baseline 갱신 전용 PR임을 표시하는 방법 — PR 제목/브랜치가 아니라 **명시적 라벨**로 판정한다. PR에 `baseline-update` 라벨(설정 `baselineGuard.exemptLabel`, 기본 `baseline-update`)이 붙어 있고 **그 PR의 변경이 baseline 파일 + 관련 문서에 한정**되면 error를 `info`로 낮춘다. 라벨은 사람만 부여 가능하도록 브랜치 보호/권한과 결합(§10). 라벨 정보는 `@actions/github` PR 컨텍스트에서 읽는다.
  - 라벨이 있어도 **소스 코드 파일이 함께 변경**되면 예외를 적용하지 않고 `error` 유지("baseline과 코드를 같은 PR에서 섞지 말 것" — 우회 방지).
- **오탐 최소화**: 대상 glob이 매우 좁아(가드 전용 baseline 파일) 일반 파일과 충돌 없음. 최초 baseline 파일 생성(파일이 base에 없던 최초 도입 PR)은 `baselineGuard.allowInitialCreate=true`(기본)면 `warning`으로 완화.
- **README 명시(문서 계획)**: README "Baseline 파일 운영 규칙" 섹션에 (1) baseline 파일 목록, (2) "기능 PR에서 절대 수정 금지", (3) 갱신은 `baseline-update` 라벨을 단 별도 PR로만, (4) 라벨 부여 권한 제한 절차를 기술한다.

---

## 5. 기술 스택 결정 + 근거

| 결정 | 선택 | 근거 (AGENTS.md "표준 라이브러리/최소 의존성 우선" 준수) |
|---|---|---|
| Action 타입 | **JS Action (Node 20, TypeScript)** | GitHub Action 1급 시민, octokit·toolkit이 JS. 정적 파싱·diff·SARIF를 코드로 다뤄야 함. composite(bash)로는 유지 불가. |
| 언어 | **TypeScript** | 검출기 로직 타입 안전성 + 자기 테스트 용이. |
| 런타임 | Node 20 (Action `using: node20`) | GitHub 표준 지원 런타임. |
| GH 연동 | `@actions/core`, `@actions/github`(octokit) | 공식 toolkit. 어노테이션·입력·Check Run·diff·PR 라벨. 직접 fetch 대신 표준 사용. |
| JS/TS 파싱 | `@babel/parser` (+ 자체 경량 워커) | 전체 TS 타입체커 불필요, 문법 트리만 필요 → babel로 충분(가볍고 JSX/TS 문법 커버). typescript 패키지 풀 로드 회피. |
| YAML | `yaml` | 워크플로/설정 파싱 표준. |
| XML | `fast-xml-parser` | JUnit XML 파싱. 무겁고 취약한 xml2js 회피. |
| 설정 검증 | `zod` | 스키마 검증·기본값·에러 메시지. |
| diff | octokit `repos.compareCommits` + 최소 unified-diff 파서(자체) | 외부 diff 파서 대신 GitHub API가 주는 patch를 직접 파싱해 added/removed 라인·변경 파일 목록 추출. |
| 번들 | `@vercel/ncc` | Action 배포용 단일 `dist/index.js`. node_modules 커밋 회피. |
| 테스트 | `vitest` | 빠르고 TS 네이티브. **주의**: 자기 자신을 검사하는 도구이므로 자체 테스트 설정도 검출 대상 규칙을 위반하지 않게 관리(§8). |
| 로컬 실행/컨테이너 | `docker-compose.yml`(Node 20 개발 컨테이너) | 로컬에서 Action을 CLI 모드로 픽스처에 돌려보기 위함. DB/Redis 불필요(이 도구는 상태 없음). §11. |

- **인프라 요소 근거(왜 지금 필요한가)**:
  - GitHub Action 런타임: 이 도구의 배포 형태 자체(제약 4). 별도 서버 없음.
  - SARIF 업로드(codeql-action): 지금 필요 — findings를 Security 탭·리뷰에 표준 포맷으로 노출하기 위함.
  - docker-compose: 지금 필요 — 로컬에서 픽스처 리포지토리에 도구를 재현 가능하게 실행/테스트하기 위함(DB·캐시·큐는 이 도구에 불필요하므로 미포함).
  - Sentry/모니터링 스택: **미포함** — Action은 실행 로그가 GitHub Actions UI에 남고, 상태체크가 곧 지표. MVP에 별도 모니터링 불필요.

---

## 6. 마일스톤 분할 (MVP = 3개)

각 마일스톤은 독립적으로 완성·테스트 가능하며, 각 기능마다 최소 1개 테스트를 포함한다(AGENTS.md 준수). 각 마일스톤 전후로 프로젝트 저장소에 `milestone-N: 요약` 커밋.

### 마일스톤 1 — 코어 스캐폴드 + diff 파이프라인 + 정적 검출기 3종 (억제 주석은 diff 신규만)
- **목표**: Action 골격, 설정 로딩, diff 컨텍스트, 정적 파싱 기반 검출기 3종(스킵, 빈 어서션, 억제 주석의 **diff 신규 증가만**)과 findings→상태체크/어노테이션 렌더까지 end-to-end 1회 통과.
- **산출물**:
  - `action.yml`(입력/출력/`using: node20`), `src/index.ts`, `src/cli.ts`
  - `config/schema.ts`(zod) + `config/presets.ts`(node 프리셋 최소)
  - `git/diff.ts`(octokit compare + unified-diff 파서, 변경 파일 목록 포함) 또는 로컬 모드용 git diff
  - `parse/js-ast.ts`
  - `detectors/skipped-tests.ts`(검출기 1), `detectors/empty-assertions.ts`(검출기 2), `detectors/suppression-ratchet.ts`(검출기 6 — **§4.6-A diff 신규 증가(`maxNewPerPR`)만**; 총량 ratchet·baseline 읽기 로직은 M2로 이월)
  - `report/annotations.ts`, `report/checkrun.ts`
  - `vitest` 셋업 + 픽스처 디렉토리 `test/fixtures/`
- **완료 기준(DoD)**:
  1. `test/fixtures/`의 "나쁜" 리포에 CLI 모드로 실행 시 3종 검출기가 각각 최소 1건 finding을 낸다(억제 주석은 PR 신규 추가분으로 error).
  2. "깨끗한" 픽스처에는 findings 0건(오탐 없음).
  3. diff 모드에서 added 라인 `.only`는 error, 레거시는 warning으로 분류됨을 테스트로 검증.
  4. 각 검출기당 최소 1개 vitest 테스트 통과. `fail-on=error` 시 exit code non-zero 확인 테스트.
  5. 억제 주석 검출기는 **diff 신규 카운트 경로만** 테스트하며, 총량 ratchet 미구현이 M1 범위임을 코드 주석·테스트로 명시(레거시 억제 총량은 이 단계에서 카운트하지 않음).

### 마일스톤 2 — env 누락(#3) + 실패무시/가드약화 + 커버리지·억제 총량 ratchet + baseline 변경 감지 + "테스트 0건" 하드페일
- **목표**: 나머지 검출기(3·4·5·7)와 억제 총량 ratchet(6-B), 하드페일 완성. diff/ratchet·env·결과파일·YAML 파싱 계열 + baseline 봉인.
- **산출물**:
  - `parse/envrefs.ts`, `parse/yaml-scan.ts`(가드 스텝/입력 추출 포함), `parse/junit.ts`
  - `detectors/env-missing.ts`(검출기 3), `detectors/ignored-failures.ts`(검출기 4 — 실패무시 A + **가드 스텝 제거/`fail-on` 완화/`test-results-glob` 제거 B**), `detectors/coverage-ratchet.ts`(검출기 5), `detectors/baseline-change.ts`(검출기 7), `detectors/zero-tests.ts`(#3)
  - 검출기 6 **총량 ratchet(6-B)** 추가 구현
  - baseline 파일 관리(`.github/false-clean-pass-coverage.json`, `-suppressions.json`) 읽기/생성 안내 로직
  - `next`/`python` 프리셋 추가
- **완료 기준(DoD)**:
  1. 픽스처: 코드가 `process.env.JWT_SECRET`를 참조하는데 `.env.example`·`ci-env-keys` 어디에도 없으면 error 1건.
  2. 픽스처: 워크플로에 새로 추가된 `continue-on-error: true` / `|| true` / `--passWithNoTests` 각각 error 탐지.
  3. 픽스처: **가드 스텝 제거 / `fail-on` error→warning 완화 / `test-results-glob` 제거** 각각 error 탐지(검출기 4-B). 가드 스텝을 다른 워크플로로 이동한 경우는 오탐 없음(전체 워크플로 집합 기준) 테스트 포함.
  4. 픽스처: `coverageThreshold` 80→70 하향 시 error(검출기 5); JUnit XML `tests="0"`이면 하드페일 error(#3).
  5. 픽스처: `.github/false-clean-pass-coverage.json` 수정 diff가 error(검출기 7); `baseline-update` 라벨 + baseline-only 변경이면 info로 완화; 라벨 있어도 소스 코드 동반 변경이면 error 유지 — 3케이스 테스트.
  6. 픽스처: 억제 주석 총량이 baseline보다 증가하면 warning(검출기 6-B).
  7. 각 검출기·하드페일당 최소 1개 vitest 테스트. env 동적 접근은 info로만 나오는 오탐 테스트 포함.

### 마일스톤 3 — SARIF + PR 코멘트 + 오케스트레이션 통합 + 패키징/문서
- **목표**: 7종+하드페일을 단일 상태체크·SARIF·PR 코멘트로 통합 출력. Action 번들·배포 문서.
- **산출물**:
  - `report/sarif.ts`(SARIF 2.1.0), `report/comment.ts`(idempotent 마커 코멘트)
  - `core/orchestrator.ts` 최종 통합(7종+하드페일 심각도 집계 → 단일 conclusion), `fail-on` 정책 적용
  - `@vercel/ncc` 빌드 → `dist/index.js`, `dist/cli.js`
  - `README.md`(사용법·워크플로 예시·설정 스키마·브랜치 보호 연동·**Baseline 파일 운영 규칙** §4.8·**가드 스텝 자기약화 방지** §4.4-B 안내), `.env.example`(이름만), `docker-compose.yml`
  - 예시 소비자 워크플로 `examples/consumer-workflow.yml`
- **완료 기준(DoD)**:
  1. 통합 실행: 여러 위반이 섞인 픽스처(7종 중 다수 + 하드페일)에서 단일 상태체크가 `failure`, SARIF에 모든 ruleId·위치 포함, 코멘트 요약 표 렌더됨을 테스트로 검증.
  2. SARIF가 SARIF 2.1.0 스키마 검증 통과(테스트에서 스키마 대조).
  3. `fail-on=warning`/`never` 정책별 conclusion 분기 테스트.
  4. `dist/` 번들이 최신 소스와 동기화(빌드 후 diff 없음)됨을 CI 스텝으로 확인.
  5. README에 실행 방법·워크플로 예시·브랜치 보호 필수 체크 지정 절차 + **Baseline 파일 운영 규칙(별도 PR·`baseline-update` 라벨)** + **가드 스텝 제거/임계치 완화 금지** 안내 포함.

> **전체 완료 기준(Definition of Done)**: 마일스톤 1~3 전체 검증 통과 + README + `.env.example` + `docker-compose.yml` + 실행 방법 문서 + 예시 워크플로 + 자기-픽스처 테스트 통과 + `dist/` 번들 동기화 확인 + 사람 최종 확인.

---

## 7. 설정 파일 스키마 예시 (`.github/false-clean-pass.yml`)

```yaml
# .github/false-clean-pass.yml
version: 1
preset: node            # node | next | python | none  (프리셋 위에 아래 값 병합)
failOn: error           # error | warning | never  (with.fail-on 이 우선)

diffMode: pr            # pr(base↔head) | commit(이전 커밋)  — 오탐 최소화 핵심 스위치

testGlobs:
  - "**/*.{test,spec}.{js,ts,jsx,tsx}"
  - "tests/**/*_test.py"

detectors:
  skippedTests:
    enabled: true
    onlyAlwaysError: true        # .only 는 항상 error
    newSkipSeverity: error       # PR 신규 .skip
    legacySkipSeverity: warning  # 기존 .skip
  emptyAssertions:
    enabled: true
    emptyBodySeverity: error
    noAssertSeverity: warning
    customAssertions: ["expectSaga", "assertMatch"]  # 커스텀 assert 헬퍼
    ignoreTodo: true
  envMissing:
    enabled: true
    required: ["JWT_SECRET", "DATABASE_URL"]   # 필수 키 이름(값 아님)
    exampleFiles: [".env.example"]
    ignore: ["NODE_ENV", "CI", "PATH", "HOME"]
    dynamicAccessSeverity: info
  ignoredFailures:
    enabled: true
    newSeverity: error
    legacySeverity: warning
    allowJobs: ["experimental-nightly"]        # 정당한 continue-on-error job
    allowCleanupCommands: true
    # --- 가드 자기약화 방지 (검출기 4-B, 조건부 승인) ---
    guardStepNames: ["false-clean-pass"]       # 본 Action 참조 스텝 식별자(uses 값 부분매칭)
    guardWeakeningSeverity: error              # 가드 스텝 제거 / fail-on 완화 / test-results-glob 제거
  coverageRatchet:
    enabled: true
    thresholdDropSeverity: error   # 설정 파일 임계치 하향
    tolerance: 0.5                  # 실측 커버리지 허용 흔들림(%p)
    baselineFile: ".github/false-clean-pass-coverage.json"
  suppressionRatchet:
    enabled: true
    maxNewPerPR: 0                  # M1: PR 신규 억제 주석 허용 수(초과 시 error)
    totalIncreaseSeverity: warning  # M2: 총량 baseline 대비 증가 시
    requireReason: false
    baselineFile: ".github/false-clean-pass-suppressions.json"
    excludePaths: ["**/fixtures/**", "**/__mocks__/**"]
  baselineGuard:                    # 검출기 7 (조건부 승인, MVP)
    enabled: true
    paths: [".github/false-clean-pass-*.json"]  # 감시 대상 baseline glob
    changeSeverity: error           # baseline 파일 변경 시(기본 하드 error)
    exemptLabel: "baseline-update"  # 이 라벨 + baseline-only 변경이면 info로 완화
    allowInitialCreate: true        # 최초 생성 PR은 warning으로 완화

zeroTests:                # #3 하드페일
  enabled: true
  skipRatioMax: 0.9       # 스킵 비율 90% 초과 시 warning
```

`with.fail-on`(Action 입력)이 설정 파일의 `failOn`보다 우선. 모든 `enabled: false`는 개별 검출기 off 토글. **단 `baselineGuard`와 `zeroTests`는 가드 무력화 방지를 위해 `enabled: false`로의 변경 자체가 검출기 7·4-B의 감시 대상이 될 수 있음(설정 파일도 baseline·가드 약화 관점에서 diff 추적).**

---

## 8. 테스트 전략 (자기 자신에게 픽스처 먹이기)

- **픽스처 리포지토리 방식**: `test/fixtures/` 아래에 소형 가짜 프로젝트를 둔다.
  - `test/fixtures/clean/` — 위반 0건(오탐 회귀 방지의 기준선).
  - `test/fixtures/skips/` — `.only`/`.skip`/`xit` 포함 테스트 파일.
  - `test/fixtures/empty-assert/` — assert 0개·빈 본문 테스트.
  - `test/fixtures/env-missing/` — `process.env.JWT_SECRET` 참조하나 `.env.example` 누락.
  - `test/fixtures/ignored-failures/` — `continue-on-error: true`·`|| true`·`--passWithNoTests` 워크플로.
  - `test/fixtures/guard-weakening/` — 가드 스텝 제거 / `fail-on` 완화 / `test-results-glob` 제거 before-after 워크플로(검출기 4-B).
  - `test/fixtures/coverage-drop/` — before/after `coverageThreshold` 숫자.
  - `test/fixtures/suppressions/` — 신규 `eslint-disable`·`@ts-ignore` 추가 diff(M1) + 총량 증가(M2).
  - `test/fixtures/baseline-change/` — `.github/false-clean-pass-coverage.json` 수정 diff / `baseline-update` 라벨 케이스 / 라벨+코드 동반 변경 케이스(검출기 7).
  - `test/fixtures/zero-tests/` — `tests="0"` JUnit XML.
- **diff 시뮬레이션**: 실제 GitHub API 없이 테스트하기 위해 `git/diff.ts`는 주입 가능한 diff provider 인터페이스로 설계. 테스트는 `.patch`/before-after 파일 쌍으로 unified diff를 만들어 주입. PR 라벨도 주입 가능한 컨텍스트로 설계(검출기 7 테스트용).
- **골든 파일**: 각 픽스처 실행 결과 findings JSON과 SARIF를 스냅샷(골든)으로 저장, 회귀 검증.
- **자기 무결성(dogfooding)**: 이 도구의 자체 리포에 자기 Action을 CI로 걸어 `false-clean-pass` 체크가 자기 코드에도 초록임을 확인(자기 테스트 스위트에 `.skip`/억제주석/빈 어서션 없음을 강제). 단 픽스처 디렉토리는 검출 제외(설정 `excludePaths`). 자기 리포의 baseline 파일도 검출기 7의 대상이 되므로 baseline 갱신은 `baseline-update` 라벨 PR로만 수행.
- **단위/통합 분리**: 파서(`parse/*`)·검출기는 단위 테스트, orchestrator·report는 통합 테스트.
- **오탐 회귀 게이트**: `clean` 픽스처에서 findings 1건이라도 나오면 CI fail(오탐 0 유지).

---

## 9. 리스크 & 완화

| 리스크 | 근거(리서치) | 완화 |
|---|---|---|
| **CI 부하 증가** | 뮤테이션 테스트는 느림; 파싱 반복 | 뮤테이션 제외·경량 AST 카운트만. diff 대상 파일만 파싱(전체 스캔 회피). 병렬 검출기 실행. 목표: 중형 PR에서 30초 이내. |
| **오탐(false positive)** | 파편 도구도 오탐으로 신뢰 잃음 | diff 우선(신규만 error, 레거시 warning), AST 기반, allowlist/`excludePaths`, `clean` 픽스처 회귀 게이트, 커스텀 assert/env allowlist 설정 제공. 검출기 4-B는 워크플로 전체 집합 기준 판정으로 스텝 이동 오탐 방지. |
| **강제력 부재** | 진짜 차단은 서버측 브랜치 보호에서 나옴 | 우리는 신호·상태체크 제공자. README에 "이 체크를 브랜치 보호의 required status check로 지정" 절차 명시(§10). Action 단독으로는 권고, 결합 시 차단. |
| **에이전트가 가드 자체를 약화** | DebugML: 클래스파이어 사보타주 | **MVP로 baseline 변경 감지(검출기 7) + 가드 스텝/임계치/결과glob 약화 탐지(검출기 4-B)를 편입**해 자기무력화 1차 차단. 나머지 설정 해시 봉인·required-check 대조는 v2. baseline 갱신은 `baseline-update` 라벨(사람 권한) 별도 PR로만. |
| **언어/프레임워크 폭** | 다언어 유지보수 부담 | MVP는 JS/TS 우선 + Python 부분. 규칙을 프리셋/설정으로 외부화해 확장 시 코드 변경 최소화. |
| **테스트 결과 파일 신뢰성** | 결과 파일 위조 가능(SpecBench) | "0건 하드페일"은 결과 파일 파싱에 의존 → 결과 파일 부재도 warning. `test-results-glob` 제거는 검출기 4-B가 error로 차단. v2에서 결과 산출 봉인/해시 검증. MVP 한계로 README 명시. |
| **baseline 라벨 오남용** | 에이전트가 `baseline-update` 라벨을 스스로 붙여 봉인 우회 | 라벨 부여 권한을 사람/메인테이너로 제한(§10). 라벨 있어도 소스 코드 동반 변경 시 예외 미적용(§4.8). |
| **GITHUB_TOKEN 권한** | 코멘트/체크런/라벨 조회 필요 | 워크플로에 `permissions: { pull-requests: write, checks: write, contents: read }` 최소 권한 명시(README). fork PR은 토큰 제약 → 코멘트 실패 시 어노테이션·SARIF로 폴백. |
| **번들(dist) 표류** | JS Action은 커밋된 dist 사용 | CI에서 `ncc build` 후 diff 없음 검사(마일스톤 3 DoD 4). |

---

## 10. "사람이 준비할 것" 목록

> 인프라·시크릿 경계 규칙: 아래는 **요청 목록**이며 에이전트가 직접 수행하지 않는다. 실제 값·계정 생성·권한 부여는 사람이 한다. 시크릿 값은 이 문서·코드에 절대 기록하지 않는다.

### 10.1 외부 자원 / 계정
1. **GitHub 저장소 생성** (public 권장 — Marketplace 게시 및 오픈소스 Action 배포용). 저장소명 예: `false-clean-pass-ci-guard`.
2. **GitHub Marketplace 게시 자격**: Action을 Marketplace에 올리려면 저장소 소유 계정에 2FA 활성화 + Marketplace 게시 동의(사람이 GitHub UI에서 수행). MVP 검증까지는 게시 없이 로컬/직접 참조로 사용 가능.
3. **릴리스 태그 정책 결정**: `v1` 이동 태그(major) 운영 방식. 사람이 릴리스 정책 승인.

### 10.2 시크릿 / 토큰 (이름만 — 값 금지)
- `GITHUB_TOKEN`: **발급 불필요**. 소비자 워크플로에서 `${{ secrets.GITHUB_TOKEN }}`(GitHub 자동 제공) 참조. 사람이 할 일은 워크플로에 최소 권한 부여(`permissions:` 블록)뿐.
- 이 도구 자체는 별도 API 키·DB 자격증명·서드파티 토큰이 **필요 없다**(상태 없는 정적 검사기). 추가 시크릿 발급 요청 없음.

### 10.3 저장소 설정 / 권한 (사람이 GitHub UI에서)
1. **브랜치 보호 규칙**: 보호 대상 브랜치(예: `main`)에 **required status check = `false-clean-pass`** 지정. (이걸 해야 실제 머지 차단 강제력이 생김 — §9)
2. **워크플로 권한**: Actions 설정에서 `GITHUB_TOKEN` 기본 권한을 read로 두고, 소비자 워크플로에서 `pull-requests: write`, `checks: write`를 명시 허용.
3. **`baseline-update` 라벨 생성 + 권한 제한**: 검출기 7의 baseline 봉인 예외에 쓰이는 `baseline-update` 라벨을 저장소에 생성하고, **이 라벨을 붙일 수 있는 권한을 사람/메인테이너로 제한**(에이전트·일반 기여자가 스스로 봉인을 우회하지 못하게). GitHub 라벨 권한/브랜치 보호 리뷰 규칙과 결합.
4. **(권장) CODEOWNERS**: `.github/false-clean-pass.yml`·`.github/workflows/**`·baseline 파일(`.github/false-clean-pass-*.json`)을 CODEOWNERS로 보호(v2 메타 계층 준비 + baseline 변경 리뷰 강제). 지금은 권고.
5. **Code scanning(SARIF) 활성화**: Security 탭에서 code scanning 사용 설정(SARIF 업로드 표시용). 조직 정책에 따라 사람이 허용.

### 10.4 배포 경계
- 이 프로젝트의 "배포"는 **git push + GitHub 릴리스 태그**까지가 에이전트 권한. Marketplace 실제 게시(공개)는 사람이 GitHub UI에서 최종 수행. push 전 디스코드 승인.

---

## 11. 의존성 목록 (오케스트레이터가 설치)

프로젝트 폴더에서 사람 승인 후 오케스트레이터가 직접 설치한다(Codex 샌드박스 네트워크 제약 대비).

### 런타임 의존성 (`dependencies`)
- `@actions/core` — 입력/출력/어노테이션/로그
- `@actions/github` — octokit(diff, Check Run, PR 코멘트, PR 라벨 조회)
- `@babel/parser` — JS/TS 경량 AST 파싱
- `yaml` — 워크플로/설정 YAML 파싱
- `fast-xml-parser` — JUnit XML 파싱
- `zod` — 설정 스키마 검증

### 개발 의존성 (`devDependencies`)
- `typescript`
- `@types/node`
- `vitest` — 테스트 러너
- `@vercel/ncc` — Action 단일 번들 빌드
- `@babel/types` — AST 노드 타입(babel 파싱 보조)
- (선택) `ajv` + SARIF JSON 스키마 — SARIF 스키마 검증 테스트용

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
> 왜 지금 필요한가: 로컬에서 Action을 CLI 모드로 픽스처 리포에 재현 실행/테스트하기 위함. 이 도구는 상태가 없어 DB·Redis·큐 컨테이너는 포함하지 않는다.

---

## 부록 A — 소비자 워크플로 예시 (`examples/consumer-workflow.yml`)

```yaml
name: false-clean-pass
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]  # 라벨 변경도 재실행(검출기 7)
permissions:
  contents: read
  pull-requests: write
  checks: write
  security-events: write   # SARIF 업로드용
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # base↔head diff 위해 전체 히스토리
      # (사용자 프로젝트의 테스트/커버리지를 먼저 실행해 결과 파일 생성)
      - run: npm ci && npm test -- --reporter=junit --outputFile=junit.xml
      - uses: <owner>/false-clean-pass-ci-guard@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          test-results-glob: "junit.xml"        # 제거하면 검출기 4-B가 error
          coverage-summary: "coverage/coverage-summary.json"
          ci-env-keys: "DATABASE_URL,JWT_SECRET" # 값 아님, 키 이름만
          fail-on: error                          # 완화하면 검출기 4-B가 error
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: false-clean-pass.sarif
```
