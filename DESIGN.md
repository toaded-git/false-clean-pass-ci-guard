# false-clean-pass v2 설계서 (Organization Evidence Report + C-lite 라이선스 + 무료 코어 개선)

작성: 2026-07-11 (architect)
개정: 2026-07-11 (설계 red-team FIX 1회차 반영 — FIX-B1/B2/B3/C1/D1 + 권고 2건)
개정: 2026-07-11 (범위 내 정밀화 — M3 발급자 키 롤오버(keyId 맵 기반) + M4 Evidence Record 장기 보존(커밋 레코드 저장소). 범위 확대·신규 인프라·D-1/D-2/D-3 위반 없음 → red-team 재검증 불요)
대상 구현자: Codex (1인 + 에이전트 팀)
1차 근거 문서:
- research/false-clean-pass-v2-monetization-2026-07-11.md (확정 수익화 방향서, §1~§5)
- research/evaluation-r4-v2.md (무료/유료 분리선 표 + Organization Evidence Report 정의)
- reviews/r4-v2-monetization-v2-2026-07-11.md (red-team PASS + 설계 제약 D-1/D-2)
- reviews/false-clean-pass-v2-design-2026-07-11.md (설계 red-team FIX — 이 개정의 근거)
- research/false-clean-pass-v2-backlog.md (P1~P3 백로그)

> 이 문서는 Codex가 읽고 그대로 구현한다. 모호한 표현을 쓰지 않는다. 파일 경로·함수 시그니처·스키마·판정 규칙을 구체적으로 명시한다.

---

## 0. 절대 준수 제약 (설계 red-team 게이트 — 위반 시 재작업)

이 설계는 아래 제약을 구조적으로 지킨다. 각 마일스톤 DoD에 위반 여부 자가검증 항목을 넣는다.

- **D-1 서명은 셀링포인트 아님**: 유료 가치의 1차 근거는 "조직 전역 여러 repo 집계 + 장기 시계열 이력을 발급자가 서버측에서 유지·생성(직접 구축 TCO·운영 아웃소싱)"이다. Ed25519 서명은 **리포트 산출물 무결성(변조 탐지) 보조**로만 쓴다. README·문구·코드 주석 어디에도 "감사자가 우리 서명을 신뢰한다"류 순환논리를 쓰지 않는다.
- **D-2 fork 방어 = 발급자 서버측 집계 상태**: fork가 복제 못 하는 것은 서명 키가 아니라 "여러 repo를 가로지르는 집계·시계열 축적 자체"다. 이 집계는 **리포트 발급 시점 배치(정적 산출)**로만 수행한다. 상시(always-on) 백엔드·웹훅 상주 프로세스를 두지 않는다.
- **D-3 조직 집계 = 단일 repo 정적 산출물(아티팩트) 한정**: 조직 집계 리포트는 하나의 "증적 수집 repo" 안에서 정적 파일로 생성된다. 조직 전역 실시간 대시보드·상태 DB·App화로 확장하지 않는다.
- **v1 원칙 유지**: 런타임(CI 실행)은 상태 없는 정적/diff 검사기 + 네트워크 0. 추가 시크릿·외부 인프라 없음(GitHub 자동 제공 `GITHUB_TOKEN`만). 결정적(deterministic).

발급 파이프라인(리포트 생성기, 라이선스 발급 스크립트)만 사람이 로컬/CI에서 수동 트리거로 실행하는 배치이며, 이는 런타임 Action과 분리된 별개 실행 컨텍스트다.

---

## 1. 개요 및 v1 대비 변경점

### 1.1 v1 현황 (이미 배포됨)
v1은 단일 GitHub Action(`false-clean-pass`)이다. PR 단위로 "CI가 그린인데 실제로는 깨진 상태"를 탐지해 required status check로 배포 전 실패시킨다. 검출기 7종 + 실행 테스트 수 급감 하드페일을 하나의 상태체크로 통합했다. 상태 없음·네트워크 0·`GITHUB_TOKEN`만 사용. Marketplace 게시 완료(github.com/marketplace/actions/false-clean-pass).

### 1.2 v2가 얹는 것 (세 갈래, 사람 지정 범위)
1. **[유료] required job 조용한 무력화 탐지 + Organization Evidence Report**
   - 런타임 탐지(무료·유료 공통): required로 지정된 job이 `if:`/`on:` 조작으로 조용히 skip=success로 위장되는 것을 PR 단위로 탐지. + false-clean-pass 시도 이력(가드 약화 이벤트) 수집.
   - 각 PR run은 탐지 결과를 **구조화된 Evidence Record(JSON)** 로 아티팩트에 남긴다.
   - 별도 발급 파이프라인이 여러 repo의 Evidence Record를 모아 **조직 집계 리포트(정적 아티팩트)** 를 생성한다. 이 집계 리포트 생성이 유료 기능이다.
2. **[C-lite 라이선스 게이트]** 개인 무료 / 조직 유료 분리선. 조직 계정에서 유료 산출(조직 집계 리포트 생성 + 조직 집계용 Evidence Record 서명 포함)을 활성화할 때 Ed25519 서명 라이선스를 secret으로 주입 → 임베드 공개키로 로컬 검증(런타임 네트워크 0). **단, 이 게이트는 기술적 강제가 아니라 라이선스 준수(honor-system) 유도이며 우회 가능하다(§8.1 정직 명시).**
3. **[무료 코어 개선]** v2 백로그 P1·P3의 사용성/정확도 항목(continue-on-error allowlist, allowJobs dead config 해소, CODEOWNER team fallback, 실행수 ratchet 정교화, 억제이유 검증). 무료 유지.

### 1.3 무엇이 바뀌지 않는가
- v1 검출기 7종 + 실행수 급감 하드페일의 판정 로직은 유지(개선만 추가).
- 런타임 Action은 여전히 네트워크 0·상태 없음·`GITHUB_TOKEN`만.
- 단일 repo 탐지는 전부 무료(라이선스 불필요). 라이선스는 조직 집계 산출에만 관여.

---

## 2. 무료/유료 기능 경계 (명확화 표)

> **경계의 성격(FIX-C1)**: 아래 "유료" 행은 **기술적으로 잠긴 벽이 아니다.** 런타임의 개인/조직 판별·라이선스 검증은 **라이선스 준수 유도(honor-system)**이며 fork·1인 org·개인 repo 이동으로 우회 가능하다(§8.1). 유료의 **실질적** 방어는 owner.type 게이트가 아니라 **"발급자 서버측 집계 파이프라인이 발급자 개인키 없는(=서명 없는) Evidence Record를 조직 집계 리포트에 넣지 못한다"**는 파이프라인 사실이다(§8.3). 이는 서명을 셀링하는 것이 아니라(D-1 준수), "무서명 레코드는 발급자 집계에 못 들어감"이라는 운영 구조를 서술하는 것이다.

| 영역 | 무료 (라이선스 불필요) | 유료 (조직 라이선스로 활성 트리거 — honor-system) |
|---|---|---|
| v1 검출기 7종 + 실행수 급감 하드페일 | 전부 무료 | — |
| required job skip=success 탐지 (런타임, PR 단위) | 무료 (개인·조직 공통, 로컬 PR 방어) | — |
| continue-on-error allowlist (P1-1) | 무료 | — |
| allowJobs 실적용 / dead config 해소 (P1-2) | 무료 | — |
| CODEOWNER team fallback (P3-5) | 무료 (기본 off) | — |
| 실행수 ratchet 정교화·억제이유 검증 (P3-6·7) | 무료 | — |
| Evidence Record(JSON) 생성 (PR run당, 무서명) | 무료 (아티팩트로 로컬 산출) | — |
| **여러 repo Evidence Record 조직 집계** | 없음 | **유료 (발급자 파이프라인만 생성)** |
| **조직 시계열 이력 리포트 (기간별 추세·반복 시도자·반복 repo)** | 없음 | **유료** |
| **컴플라이언스 evidence input 요약(SOC2/ISO 매핑 힌트)** | 없음 | **유료 (통제 이행 증명 아님, evidence input 힌트만 — §6.2)** |
| **집계 리포트 무결성 서명(Ed25519, 변조 탐지 보조)** | 없음 | **유료 (D-1: 셀링 아님, 무결성 보조)** |

핵심: **단일 repo에서 벌어지는 모든 탐지·방어는 무료.** 돈을 받는 것은 "여러 repo에 걸친 집계·장기 이력·컴플라이언스 산출물을 발급자 파이프라인이 만들어 주는 것"이다(직접 구축 TCO·운영 아웃소싱). owner.type 게이트는 이 유료 산출을 **활성화하는 트리거이자 준수 유도**일 뿐, 유료 방어의 실질이 아니다.

---

## 3. 기술 스택 / 저장소 구조

### 3.1 스택
- **언어/런타임**: Node.js 20 (v1과 동일). GitHub Actions `node20` 런타임에서 `dist/index.js` 실행.
- **번들러**: `@vercel/ncc`로 단일 파일 번들(v1과 동일, 의존성 vendored → 런타임 npm install 없음).
- **YAML 파싱**: `yaml` (npm, eemeli/yaml). AST/CST 접근으로 라인 매핑 가능.
- **GitHub API**: `@actions/github`(octokit) + `@actions/core`. `GITHUB_TOKEN`만.
- **서명(Ed25519)**: Node.js 내장 `crypto`(`crypto.sign`/`crypto.verify`, ed25519). 외부 서명 라이브러리 불필요.
- **테스트**: `vitest` (또는 v1이 쓰던 러너 유지 — v1 러너와 통일).
- **라이선스 발급 스크립트**: Node.js 스크립트(`tools/issue-license.mjs`), 로컬/발급 CI에서만 실행. **MVP 필수는 자체 `issue-license.mjs` 하나뿐.** keygen.sh 연동은 선택·비필수(§9.2).

> Codex 주의: v1 저장소가 이미 존재한다. v2는 **v1 저장소(projects/false-clean-pass-ci-guard) 위에 증분**한다. 새 프로젝트가 아니다. 기존 검출기 모듈을 재사용하고, 아래 신규 모듈을 추가한다. v1의 실제 파일명이 이 설계와 다르면 v1 파일명을 우선하고 이 설계의 모듈 경계(책임 분리)만 따른다.

### 3.2 저장소 모듈 구조 (v2 추가/변경)

```
projects/false-clean-pass-ci-guard/
├── action.yml                         # (변경) 신규 입력 추가: license, evidenceOutput, requiredJobs 등
├── src/
│   ├── index.js                       # (변경) 엔트리: 검출 → Evidence Record 산출 → 판정
│   ├── detectors/                     # v1 검출기 7종 (재사용)
│   │   ├── ... (v1 기존)
│   │   └── requiredJobSkip.js         # (신규) required job skip=success 탐지 (§5)
│   ├── core/
│   │   ├── workflowParser.js          # (신규) 워크플로 YAML 파싱 + job/스텝 스코프 + check이름 매핑 (§5.3)
│   │   ├── allowlist.js               # (신규) continue-on-error allowlist + 인라인 주석 예외 (§7.1)
│   │   ├── jobScope.js                # (신규) 라인→job 매핑 (allowJobs 실적용, §7.2)
│   │   ├── codeownerFallback.js       # (신규) team-owner fallback (§7.3)
│   │   ├── ratchet.js                 # (변경) 실행수 급감 정교화 + 억제이유 검증 (§7.4)
│   │   ├── canonicalJson.js           # (신규) 결정적 canonical JSON 직렬화 (§8.2, M3)
│   │   └── evidenceRecord.js          # (신규) Evidence Record 스키마 직렬화 (§6.1)
│   └── license/
│       ├── verify.js                  # (신규) Ed25519 로컬 검증 + keyId 조회 + 개인/조직 판별 (§8)
│       └── embeddedPublicKey.js       # (신규) 임베드 공개키 keyId→공개키 맵 (§8.2, 단일 상수 아님)
├── tools/
│   ├── issue-license.mjs              # (신규·MVP 필수) 라이선스 발급 스크립트 (오프라인, keyId 지정, 발급자만) (§9.1)
│   ├── aggregate-report.mjs           # (신규) 조직 집계 리포트 생성기 (배치, 커밋 레코드 저장소 소스 재집계 지원) (§6.2)
│   └── keygen-public.pem              # (신규) 발급 검증용 공개키 (커밋됨, 비밀 아님)
├── evidence-repo-template/            # (신규) 증적 수집 repo 워크플로 템플릿 (§6.3)
│   └── .github/workflows/collect-evidence.yml
├── schemas/
│   ├── evidence-record.schema.json    # (신규) Evidence Record JSON Schema (§6.1)
│   └── org-evidence-report.schema.json# (신규) 조직 집계 리포트 JSON Schema (§6.2)
├── test/
│   └── ... (마일스톤별 테스트 + fixtures)
├── .env.example                       # (변경) 키 이름만
├── README.md                          # (변경) 무료/유료 경계·라이선스 안내·탐지 한계
└── DESIGN.md                          # 이 문서 복사본
```

> `license/embeddedPublicKey.js`는 **단일 공개키 상수가 아니라 keyId→공개키(base64) 맵**을 export한다. 예: `{ "k1": "<pubkey base64>", "k2": "<pubkey base64>" }`. 검증은 라이선스 payload의 `keyId`로 이 맵에서 공개키를 조회한다(§8.2). 이 맵 구조는 §8.5 키 롤오버 경로의 기반이다.

> docker-compose.yml은 제외한다(FIX-D1). 상태 없는 검사기에 과잉이라 로컬 테스트는 로컬 Node 20 + `npm test`로 충분하다. §11 참조.

---

## 4. 데이터 흐름 (런타임 vs 발급 배치 분리)

### 4.1 런타임 (PR CI 실행 — 네트워크 0, 무료)
```
PR event
  → Action 실행 (GITHUB_TOKEN만)
  → 워크플로 YAML 파싱 + PR diff 로드
  → 검출기 7종 + requiredJobSkip 탐지 + ratchet
  → 판정: pass/fail (required status check)
  → Evidence Record(JSON) 산출 → actions/upload-artifact 로 아티팩트 저장
     (이름: fcp-evidence-<repo>-<pr>-<headSHA>.json)
  → (조직 라이선스 있으면) Evidence Record에 서명 필드 채움 (D-1: 무결성 보조)
```
런타임은 라이선스가 없어도 탐지·판정·Evidence Record 산출까지 전부 수행(무료). 라이선스는 **Evidence Record에 조직 서명 필드를 채울지 여부**와 **집계 대상 마킹**만 좌우한다.

### 4.2 발급 배치 (조직 집계 리포트 생성 — 유료, 발급 시점만)
```
사람/발급 CI 트리거 (상시 아님)
  → 여러 repo의 Evidence Record 아티팩트 수집 (증적 수집 repo 워크플로가 다운로드)
  → 다운로드한 원본 Evidence Record 자체를 증적 수집 repo에 커밋으로 영구 보존
     (경로: evidence-records/<repo>/<YYYY>/<PR>-<headSha>.json)
     — 리포트만이 아니라 원본 레코드를 커밋해 장기 시계열·재집계·감사 재현을 보장
  → tools/aggregate-report.mjs 실행 (소스 = 커밋된 레코드 저장소; 아티팩트는 휘발성 전송 매체)
  → 조직 라이선스 검증 (Ed25519) — 없으면 집계 거부
  → 서명 없는 레코드는 집계에서 제외(발급자 개인키 없이 만든 레코드 = 신뢰 체인 밖)
  → 시계열 집계 + 반복 시도자/repo 추세 산출
  → Organization Evidence Report(JSON + Markdown) 정적 파일 산출
  → 리포트 파일 Ed25519 서명 (변조 탐지 보조)
  → 증적 수집 repo에 아티팩트/커밋으로 보존
```

> **레코드 보존 원칙(M4)**: GitHub Actions 아티팩트는 기본 90일(조직 설정에 따라 더 짧을 수 있음)에 소멸한다. 리포트만 보존하면 원본 레코드가 사라져 재집계·감사 재현이 불가능하므로, `collect-evidence`는 다운로드한 **원본 Evidence Record 자체를 증적 수집 repo에 커밋**(위 `evidence-records/...` 경로)해 항구 보존한다. 이후 집계는 아티팩트가 아니라 **커밋된 레코드 저장소를 소스로** 재집계할 수 있다. 아티팩트는 휘발성 전송 매체이고, 커밋된 레코드가 항구 보존소다. 이 커밋 레코드 저장소는 여전히 **단일 증적 repo 안의 정적 파일**(D-3 준수)이며 상태 DB·상시 서비스가 아니다.

---

## 5. required job skip=success 탐지 알고리즘 (구체)

### 5.1 탐지 대상 (위협 모델)
GitHub은 required로 지정된 status check에 대응하는 job이 `if:` 조건으로 **skip**되면 그 check를 **success로 보고**한다(path filtering만 pending 유지). 공격자는 required job에 다음을 추가해 조용히 통과시킬 수 있다:
1. **job-level `if:`** 추가/변경 — 조건이 특정 상황에서 job 전체를 skip시킴 (예: `if: github.actor != 'dependabot[bot]'`, `if: false`, `if: ${{ !cancelled() && something }}` 형태로 실질 skip 유도).
2. **`on:` 트리거 축소** — required check를 내는 워크플로의 `on:`에서 `pull_request`를 제거하거나 `paths`/`paths-ignore`/`branches`로 특정 PR을 트리거 대상에서 제외.
3. **job 이름 변경/소멸** — required check 이름과 매칭되는 job의 name/id를 바꿔 required 매칭을 우회(설정상 required 이름은 그대로인데 그 이름을 내는 job이 사라짐 → 해당 check는 아예 안 생성 → merge 시 "expected" pending 또는 우회 시도).
4. **가드 설정 자기약화 (`requiredJobs` 목록 축소)** — 공격자가 같은 PR에서 이 Action의 `with.requiredJobs` 입력값 자체를 빈 값/축소로 바꿔 감시 대상을 없애 하드페일을 통째로 무력화 (v1 red-team M-N2와 동일 계열의 자기무력화).

### 5.2 required job 목록 소스 (FIX-B1 반영 — 입력값 1차, API는 보조)
branch protection 조회 API(`GET /repos/{o}/{r}/branches/{branch}/protection/required_status_checks`)는 **admin 권한을 요구**하므로 기본 `GITHUB_TOKEN`은 대부분 **403**이다(실측: GitHub Docs + community #191524). 따라서 API를 1차 소스로 삼지 않는다.

- **1차 소스 = `with.requiredJobs` 입력값** (콤마 구분 문자열). 이 값이 실제 branch protection의 required check 목록과 동기화됨을 보장하는 것은 **사용자 책임**임을 README·경고에 정직 명시한다.
- **보조 교차검증 = branch protection API (성공 시에만)**: `GITHUB_TOKEN`으로 조회를 시도하되 403/미설정이면 **조용히 무시**(하드페일 근거 아님). 조회가 성공하면 입력값과 비교해 **불일치 시 stale 경고** 출력(`requiredJobs 입력값이 실제 branch protection과 다름 — 동기화 요망`). API 결과 자체를 하드페일 근거로 쓰지 않는다(입력값이 1차, API는 stale 탐지 보조).
- **`requiredJobs` 입력값 축소 감시 (R-5, 자기무력화 차단)**: 이 Action 호출부(`with.requiredJobs`)의 **base↔head diff**에서 목록이 축소되면(항목 제거·빈 값화) → **hard-fail** (`required_config_narrowed`). 이는 §5.5의 정보성 강등 분기보다 우선한다(축소 자체가 공격 신호이므로 강등 금지).
- 대상 워크플로 YAML: `.github/workflows/*.yml|yaml` (base 브랜치 버전 + head 브랜치 버전 둘 다).
- PR diff: base↔head 워크플로 파일 변경.

### 5.3 파싱 및 check-이름↔job 매핑 (core/workflowParser.js — FIX-B2 반영)
- `yaml` 라이브러리의 `parseDocument`로 각 워크플로 파일을 파싱(CST 유지 → 라인번호 확보).
- 각 워크플로에서 추출:
  - `on:` 트리거 (이벤트 목록, `paths`/`paths-ignore`/`branches`/`branches-ignore`).
  - `jobs.<id>`: 각 job의 `id`, `name`, job-level `if:`, `strategy.matrix`(+ `include`/`exclude`), `uses`(reusable workflow 호출 여부).
- **check 이름 재구성 규칙** (실측: GitHub community #46752/#170628 — reusable workflow의 실제 check 이름은 `caller job name / inner job name` concat):

  | job 형태 | check 이름 계산 | 매핑 확정성 |
  |---|---|---|
  | 일반 job (name 있음) | `name` | 확정 |
  | 일반 job (name 없음) | `id` | 확정 |
  | matrix job | 확장 조합마다 `name (v1, v2, ...)` (matrix 값 조합) | 확정 (include/exclude 반영) |
  | **동적 name** (`name: ${{ 표현식 }}`) | 정적 확정 **불가** | **불확정 → 경고**(조용한 매칭 실패 금지) |
  | **reusable workflow** (`jobs.X.uses: ./.github/workflows/Y.yml`, 같은 repo) | 피호출 파일 파싱 → `X / <inner job name>` concat 재구성 | 파싱 성공 시 확정, 실패 시 불확정 |
  | **reusable workflow** (외부 repo `uses: org/repo/.github/workflows/Y.yml@ref`) | 피호출 파일 접근 불가 | **불확정 → 경고**(R-1 오탐 금지) |

- **matrix include/exclude 처리 (R-1 델타 규칙)**: base와 head 각각에서 matrix 확장 조합 집합을 계산(`matrix` 곱집합 + `include` 추가 − `exclude` 제거). base 조합 집합 대비 head에서 조합이 **축소**되면(특정 조합 제거) 그 조합에 대응하는 check가 사라진 것이므로 **R-1 fail**(그 조합 이름 대상). 조합이 늘거나 동일하면 pass.
- **"매핑 불확정" 처리 원칙**: 확정 불가(동적 name / 외부 reusable / 같은 repo reusable 파싱 실패)한 required 이름은 **R-1(job 소멸) 하드페일 대상에서 제외**하고 대신 **정보성 경고 + Evidence Record `weakenings[]`에 `mapping_unresolved` 기록**. fail-closed가 오탐 폭발을 유발하지 않게 한다(v1 정직 격하 원칙). "reusable workflow 뒤로 옮기면 탐지 사각"임을 README 한계로 명시.

### 5.4 판정 규칙 (detectors/requiredJobSkip.js — FIX-B3 반영)
required로 판정된 각 check 이름 `R`에 대해. **hard-fail은 명백한 것만**(R-1 확정 매핑 소멸·R-3 트리거 축소·R-5 입력 축소), 조건부 `if:`처럼 애매한 것은 경고+기록으로 격하한다(오탐 폭발 방지).

- **R-1 (job 소멸) — hard-fail (확정 매핑만)**: head 워크플로에서 `R`에 매핑되는 job/조합이 하나도 없다 → **fail** (`required_job_missing`). 단 §5.3에서 `R`이 **매핑 불확정**(동적 name·외부 reusable·파싱 실패)이면 hard-fail이 아니라 `mapping_unresolved` 경고. matrix 조합 축소는 축소된 조합에 대해 R-1 fail.
- **R-2 (job-level if 추가/변경) — 정교화: skip 유발 if만 fail, 나머지는 경고+기록**: `R` 매핑 job에 job-level `if:`가 base 대비 head에서 신규/변경됨:
  - **명백한 skip 유발 패턴 → hard-fail** (`required_job_if_skip_risk`): `if: false`, actor/브랜치/이벤트를 특정 조건으로 배제하는 부정 조건(`github.actor != ...`, `github.ref != ...`, `github.event_name != 'pull_request'`), 또는 `!cancelled()`/`always()`를 포함하되 그 뒤에 추가 skip 조건이 AND로 붙은 형태(`!cancelled() && <추가조건>`, `always() && <추가조건>`).
  - **정당 조건부 패턴 → 오탐 억제(pass, 기록 안 함)**: `always()` 단독, `!cancelled()` 단독, `success()` 단독/조합, `needs.*.result == 'success'` 류, `github.event_name == 'push'`, `github.ref == 'refs/heads/main'` 류(배포/브랜치 조건). 정확·정규식 매칭 화이트리스트로 한정.
  - **위 어느 쪽도 아닌 애매한 신규 `if:` → 경고+기록(hard-fail 아님)**: `required_job_if_added_review` 로 Evidence Record `attempts[]`(severity `review`)에 기록 + "이 조건이 이 PR을 skip시키는지 수동 확인 요망" 경고. required 목록이 §5.2로 불확실할 수 있으므로 애매한 조건부는 hard-fail하지 않는다.
  - allowlist(§7.1)에 등록된 job이면 전부 skip.
- **R-3 (on 트리거 축소) — hard-fail**: `R`을 내는 워크플로의 `on:`에서 head가 base 대비 `pull_request` 이벤트를 제거했거나, `paths-ignore` 확대/`paths` 축소/`branches` 제한을 신규 추가해 이 PR 유형이 트리거에서 빠질 수 있게 됨 → **fail** (`required_workflow_trigger_narrowed`).
  - 판정: base의 `on` 트리거 집합과 head의 트리거 집합을 정규화 비교. head에서 `pull_request` 관련 트리거 적용 범위가 좁아지면 fail. (넓어지거나 동일하면 pass.)
  - `paths`/`paths-ignore`: base에 없던 `paths-ignore` 추가 = 축소, `paths`가 head에서 더 좁은 glob 집합 = 축소. 정밀 glob 포함관계 판정 불가한 경계는 **보수적 fail** + "수동 확인 요망".
- **R-5 (requiredJobs 입력 축소) — hard-fail (자기무력화 차단)**: §5.2대로 `with.requiredJobs` 입력값이 base↔head에서 축소되면 → **fail** (`required_config_narrowed`).
- **R-4 (실행 실측 교차확인) — 보조 신호만**: `GITHUB_TOKEN`으로 head SHA의 Check Runs 조회(`GET /repos/{o}/{r}/commits/{sha}/check-runs`). `R`이 `conclusion=skipped`거나 없으면서 required이면 경고 로깅. v1 "탐지+로깅 보조 신호" 격하 원칙과 동일하게 **보조 신호**로만(하드페일 근거는 R-1/R-3/R-5의 정적 diff).

hard-fail 항목은 Evidence Record `attempts[]`(severity `high`), review 항목은 `attempts[]`(severity `review`), 매핑 불확정은 `weakenings[]`(`mapping_unresolved`)에 기록된다(§6.1). 실제 강제력은 required status check(브랜치 보호)에서 나온다 — 설계·README에 v1과 동일하게 정직히 명시.

**탐지가 잡는 것 / 못 잡는 것 (README 필수 명시 — FIX-B2)**:
- 잡음: required job에 명백한 skip 유발 `if:` 추가, required job(확정 매핑) 소멸/개명, matrix 조합 축소, `on:` 트리거 축소, `requiredJobs` 입력 축소.
- 못 잡음(정직 한계): required job을 **외부 repo reusable workflow 뒤로 이동**(매핑 불확정 → 경고만), **동적 name(`${{ }}`)** 로 이름 은폐(경고만), **step-level `if:`**(job-level만 감시), branch protection 설정 자체를 GitHub UI에서 직접 변경(audit log 영역). 이 한계는 v1과 동일하게 "탐지+보조 신호"이며 최종 강제력은 브랜치 보호에 있음.

### 5.5 오탐 억제 및 정보성 강등 분기 (FIX-B1 반영)
- 워크플로 신규 생성(base에 파일 없음)은 R-2/R-3 대상 아님(비교 기준 없음) → 신규 파일은 R-1(확정 매핑 시)만.
- Action 자기 자신(`uses:` 지문이 이 Action인 job)은 §5 대상에서 제외(v1 자기약화 감시와 중복 방지).
- **정보성 강등은 두 경우를 구분한다**:
  - **(강등) `requiredJobs` 입력 미지정** + branch protection 조회 실패 → 감시 기준이 없으므로 전체 검출기를 정보성으로 강등(하드페일 금지). "requiredJobs 미지정" 경고.
  - **(강등 아님·hard-fail) `requiredJobs` 입력이 base에는 있었는데 이 PR에서 축소/삭제됨** → R-5 `required_config_narrowed` hard-fail. 강등으로 빠져나가지 못하게 한다(자기무력화 차단).

---

## 6. Organization Evidence Report — 산출물 스키마 (D-3: 단일 repo 정적 아티팩트)

### 6.1 Evidence Record (PR run당, 무료 산출) — schemas/evidence-record.schema.json
런타임 Action이 매 PR run마다 아티팩트로 남기는 원자 단위 레코드.

```json
{
  "schemaVersion": "1.0",
  "repo": "owner/name",
  "prNumber": 123,
  "headSha": "abcdef...",
  "baseSha": "012345...",
  "actor": "login",
  "runId": "9876543210",
  "timestamp": "2026-07-11T09:00:00Z",
  "verdict": "fail",
  "attempts": [
    {
      "kind": "required_job_if_skip_risk",
      "severity": "high",
      "target": "test (ubuntu-latest)",
      "detail": "job-level if: adds actor-exclusion skip condition to required job",
      "file": ".github/workflows/ci.yml",
      "line": 42,
      "baseValue": null,
      "headValue": "github.actor != 'dependabot[bot]'"
    },
    {
      "kind": "required_job_if_added_review",
      "severity": "review",
      "target": "lint",
      "detail": "ambiguous conditional added to required job — manual review required",
      "file": ".github/workflows/ci.yml",
      "line": 12,
      "baseValue": null,
      "headValue": "vars.RUN_LINT == 'true'"
    }
  ],
  "weakenings": [
    {
      "kind": "mapping_unresolved",
      "severity": "medium",
      "detail": "required 'deploy / build' maps via external reusable workflow — static mapping unresolved",
      "target": "deploy / build"
    },
    {
      "kind": "suppression_increase",
      "severity": "medium",
      "detail": "eslint-disable count 3 -> 9",
      "delta": 6
    },
    {
      "kind": "run_count_drop",
      "severity": "high",
      "detail": "test count 210 -> 40 (-81%)",
      "baseline": 210,
      "current": 40
    }
  ],
  "detectorSummary": { "total": 8, "failed": 2, "review": 1, "passed": 5 },
  "license": {
    "org": true,
    "licenseId": "lic_xxx",
    "signaturePresent": true
  },
  "signature": {
    "alg": "ed25519",
    "keyId": "k1",
    "value": "base64...",
    "signedFields": ["repo","prNumber","headSha","actor","timestamp","attempts","weakenings"]
  }
}
```
- `attempts[]`: required job skip=success 탐지(§5) 결과. `severity: high`=hard-fail, `severity: review`=경고+기록(수동 확인 요망).
- `weakenings[]`: false-clean-pass 시도(가드 약화 이벤트) — 억제주석 증가, 실행수 급감, continue-on-error 오남용, 매핑 불확정(`mapping_unresolved`), self-attestation 실패 등 v1/개선 검출기 신호.
- `signature`: **조직 라이선스가 있을 때만** 채워짐. 없으면 `license.org=false`, `signature=null`. `signature.keyId`는 서명에 쓰인 발급자 키의 keyId(§8.5 롤오버에서 사용). 서명은 무결성 보조(D-1) — 레코드가 발급 배치까지 변조되지 않았음을 검증하기 위함이지, "감사자 신뢰의 원천"이 아니다.

### 6.2 Organization Evidence Report (집계, 유료 산출) — schemas/org-evidence-report.schema.json
`tools/aggregate-report.mjs`가 여러 Evidence Record를 모아 생성하는 **단일 정적 파일**(JSON + 사람 열람용 Markdown 렌더). 집계 소스는 **커밋된 레코드 저장소**(§4.2 `evidence-records/...`)일 수 있으며, 이 경우 아티팩트 없이도 동일 결과를 재현한다.

```json
{
  "schemaVersion": "1.0",
  "org": "acme",
  "generatedAt": "2026-07-11T10:00:00Z",
  "period": { "from": "2026-04-01", "to": "2026-06-30" },
  "reposCovered": ["acme/api", "acme/web", "acme/infra"],
  "recordCount": 412,
  "summary": {
    "totalAttempts": 27,
    "totalWeakenings": 133,
    "reposWithAttempts": 4,
    "byKind": { "required_job_if_skip_risk": 11, "run_count_drop": 8, "suppression_increase": 6, "required_workflow_trigger_narrowed": 2 }
  },
  "timeSeries": [
    { "week": "2026-W20", "attempts": 3, "weakenings": 12 },
    { "week": "2026-W21", "attempts": 5, "weakenings": 18 }
  ],
  "repeatActors": [
    { "actor": "login-a", "attemptCount": 6, "repos": ["acme/api","acme/web"], "firstSeen": "2026-04-03", "lastSeen": "2026-06-20" }
  ],
  "repeatRepos": [
    { "repo": "acme/api", "attemptCount": 9, "distinctActors": 3 }
  ],
  "compliance": {
    "note": "This report is evidence of detected attempts to weaken CI gates across the organization. It is NOT an independent audit attestation.",
    "mappingHint": "SOC2 CC8.1 / ISO 27001 A.12.1.2 change-management EVIDENCE INPUT only — this is not proof of control implementation and does not replace an auditor's assessment."
  },
  "integrity": {
    "alg": "ed25519",
    "keyId": "k1",
    "reportSignature": "base64...",
    "note": "Signature detects tampering of this report file after issuance. It is not the basis of audit trust (see README)."
  },
  "provenance": {
    "issuer": "false-clean-pass evidence pipeline",
    "aggregationScope": "static-batch",
    "sourceRecordHashes": ["sha256:...", "sha256:..."]
  }
}
```

D-1 준수 자가검증: `compliance.note`와 `integrity.note`가 "서명 = 감사 신뢰의 원천"이 아니라 "변조 탐지 보조 + 집계 산출물"임을 명문화. 유료 가치 서술은 `compliance`/`timeSeries`/`repeat*`(집계·이력)에 둔다.

권고 반영(D-1-m): `compliance.mappingHint`는 "evidence input only / 통제 이행 증명 아님 / 감사자 평가를 대체하지 않음"을 문구에 못박는다. README도 "SOC2 매핑은 evidence input 힌트일 뿐 통제 이행 증명이 아니다"를 규칙으로 명시(M4 DoD).

D-3 준수 자가검증: 이 리포트는 **하나의 정적 파일**이며 상시 서비스 상태를 참조하지 않는다. `aggregationScope: "static-batch"`. 커밋된 레코드 저장소 역시 단일 증적 repo 내부의 정적 파일이지 상태 DB가 아니다(§4.2).

### 6.3 증적 수집 repo (evidence-repo-template)
조직이 만드는 별도 repo(예: `acme/ci-evidence`) 하나. 그 안의 워크플로 `collect-evidence.yml`가:
- 스케줄(예: 주 1회) 또는 수동 `workflow_dispatch`로 트리거(상시 아님 — D-2).
- 대상 repo 목록(설정 파일)에서 각 repo의 최신 fcp-evidence 아티팩트를 다운로드(`GITHUB_TOKEN` + org read 범위, 또는 발급자가 제공한 PAT를 secret으로).
- **다운로드한 원본 Evidence Record를 repo에 커밋해 영구 보존**(경로 `evidence-records/<repo>/<YYYY>/<PR>-<headSha>.json`). 아티팩트는 휘발성 전송 매체, 커밋된 레코드가 항구 보존소다. 다음 집계는 아티팩트가 아니라 **커밋된 레코드 저장소를 소스로** 재집계할 수 있다(재집계·감사 재현 보장).
- `tools/aggregate-report.mjs` 실행(소스 = 커밋 레코드 저장소) → 조직 리포트 생성 → 같은 repo에 커밋/아티팩트로 보존.
- 조직 라이선스 secret(`FCP_LICENSE`) 주입 → 없으면 집계 거부.

> **아티팩트 보존 기간 경고(M4 — 템플릿 주석 + README 필수)**: 수집 주기(`collect-evidence` 스케줄 간격)가 아티팩트 보존 기간보다 **짧아야** 한다. 그렇지 않으면 다음 수집 전에 아티팩트가 소멸해 레코드가 유실된다. 기본 스케줄 예시(주 1회)와 기본 아티팩트 보존(90일)의 관계: **주 1회 수집이면 90일 보존 대비 충분한 안전 마진**(약 13주분 여유)이다. 단, 조직이 아티팩트 보존을 짧게(예: 7일 미만) 설정했다면 주 1회 수집도 위험할 수 있으므로, 그 경우 수집 주기를 보존 기간보다 짧게(예: 일 1회) 당기거나 보존 기간을 늘려야 한다. 이 경고는 `evidence-repo-template/.github/workflows/collect-evidence.yml` 주석과 README 증적 수집 안내에 모두 명시한다.

이 repo 하나가 D-3의 "단일 repo 정적 산출물" 경계다. 커밋된 원본 레코드 저장소 역시 이 단일 repo 안의 정적 파일이며 상태 DB·상시 서비스가 아니다(D-3 준수).

---

## 7. 무료 코어 개선 상세

### 7.1 continue-on-error allowlist (P1-1) — core/allowlist.js
- Action 입력 `ignoredFailures.allowContinueOnErrorSteps`: 스텝 이름 또는 `uses` 패턴 목록(glob). 매칭되는 스텝의 `continue-on-error: true`는 검출기4에서 error로 잡지 않음.
- 인라인 주석 예외: 스텝 근처 라인에 `# fcp-allow: continue-on-error <사유>` 주석이 있으면 그 스텝 예외. 사유 텍스트 필수(빈 사유 = 예외 무효, ratchet 총량에는 계속 반영 — §7.4와 연결).
- 판정: allowlist/주석 매칭은 `core/workflowParser.js`의 스텝 스코프(라인 매핑)에 의존.

### 7.2 allowJobs 실적용 (P1-2) — core/jobScope.js
- v1의 `ignoredFailures.allowJobs`가 dead config였음. 해소: `core/workflowParser.js`가 라인→job 매핑을 제공하므로, 라인 기반 검출 히트의 job을 계산해 `allowJobs` 목록(기본 `["experimental-nightly"]`)에 속하면 제외.
- 또는 (구현 판단상 매핑이 과하면) 스키마에서 제거 — 단 **둘 중 하나를 반드시 선택**하고 dead config를 남기지 않는다. 본 설계는 (a) 실적용을 채택(매핑 인프라가 §5에서 이미 필요하므로 재사용).

### 7.3 CODEOWNER team fallback (P3-5) — core/codeownerFallback.js
- Action 입력 `codeownerTeamFallback`(기본 `false`). `true`일 때만 활성.
- 동작: baseline 경로가 팀(`@org/team`)에 소유될 때, REST에 "리뷰어=코드오너" 판정 엔드포인트가 없으므로 fallback으로 PR reviews API의 `author_association`(OWNER/MEMBER) + approved 리뷰를 확인. `members: read` 권한 필요 시 문서화(§10).
- fail-closed 기본은 유지. fallback은 명시적 opt-in.

### 7.4 실행수 ratchet 정교화 + 억제이유 검증 (P3-6·7) — core/ratchet.js
- 실행수 급감: base 대비 `maxDropPercent`(기본 재고: 20% → 사유 명시하면 관대) 초과 급감 시 error. 메시지를 "확인 요청"으로 구분하고 baseline 갱신 경로(§7.3 fallback)와 연결. 정당 리팩터는 baseline 갱신으로 통과.
- 억제 이유 검증: `requireReason`이 이유 유무만 보던 것을 2단으로 — "이유 없는 억제 = hard cap(초과 시 fail)" + "이유 있는 억제 = soft cap(총량 ratchet에 계속 반영)". `-- auto` 같은 무의미 이유는 내용 최소 길이/형식 검증(예: 8자 이상 + 공백 아닌 문자)으로 소프트 필터.

---

## 8. C-lite 라이선스 검증 설계 (Ed25519, 로컬·네트워크 0)

### 8.1 개인/조직 판별 — honor-system이며 기술 강제 아님 (FIX-C1)
- 런타임에 `github.event.repository.owner.type`(`User` = 개인, `Organization` = 조직)로 판별한다.
- **개인(User)**: 라이선스 불필요. 모든 탐지·판정·Evidence Record(무서명) 무료 수행. 유료 산출(집계·서명 필드)만 비활성.
- **조직(Organization)**: 탐지·판정·무서명 Evidence Record까지는 여전히 무료(단일 repo 방어는 무료). **조직 서명 필드 + 집계 대상 마킹**만 라이선스 필요. 라이선스 없으면 Evidence Record의 `license.org=false`로 산출(무료 동작).

**정직 격하(반드시 README·§8.3 명시)**: owner.type 게이트는 **기술적 강제가 아니라 라이선스 준수(honor-system) 유도**다. 다음으로 우회 가능하다(실측):
- **1인 org 무료 생성**: GitHub org는 1인이 무료·무제한으로 만들 수 있어, 유료를 피하려는 팀이 개인 계정 repo에서 작업하면 owner.type=`User`가 되어 유료 게이트를 피한다.
- **개인 repo 이동 / fork**: 조직 repo를 개인으로 옮기거나, Action을 fork해 `license/verify.js` 게이트를 한 줄 삭제하면 우회된다(Gitleaks도 동일 honor-system이며 fork `gacts/gitleaks`로 우회됨이 실측 확인).

즉 라이선스 게이트는 **런타임 탐지를 막지 않고**(무료 방어 훼손 금지), 유료 산출을 **활성화하는 트리거이자 준수 유도**일 뿐이다. 남용을 **약하게** 억제하는 것은 라이선스 payload의 `org` 일치·`maxRepos`·`expiresAt` 검증뿐이며, 이는 revocation 없음(§8.2)과 동급의 한계다.

### 8.2 라이선스 파일 형식 + 로컬 검증 흐름
- 라이선스 파일(secret `FCP_LICENSE`로 주입, base64 인코딩): JSON 페이로드 + Ed25519 서명.
```json
{
  "payload": {
    "licenseId": "lic_xxx",
    "keyId": "k1",
    "org": "acme",
    "plan": "org-evidence",
    "issuedAt": "2026-07-01T00:00:00Z",
    "expiresAt": "2027-07-01T00:00:00Z",
    "maxRepos": 50
  },
  "signature": "base64(ed25519 over canonicalJson(payload))"
}
```
- **`keyId` 필드**: 이 라이선스를 서명한 발급자 키의 식별자(예: `"k1"`). **`keyId`는 서명 대상 payload에 포함**되므로(서명이 `canonicalJson(payload)` 전체를 커버) keyId를 사후 위조하면 서명 검증이 깨진다 → keyId 위조 불가. keyId는 `embeddedPublicKey.js` 맵에서 검증에 쓸 공개키를 고르는 셀렉터다(§8.5 롤오버 기반).
- 검증(license/verify.js):
  1. `FCP_LICENSE` 디코드 → `{payload, signature}` 분리.
  2. **payload에서 `keyId`를 읽는다** → `embeddedPublicKey.js`의 keyId→공개키 맵에서 해당 keyId의 공개키를 조회한다. **맵에 없는 keyId면 미등록 키이므로 신뢰 체인 밖 → 검증 거부(fail)**. (맵에 등록된 keyId만 신뢰한다.)
  3. `core/canonicalJson.js`로 payload를 **결정적** 직렬화(키 정렬 고정) → 조회한 공개키로 `crypto.verify('ed25519', canonicalJson(payload), pubKey, sigBytes)`.
  4. 서명 유효 + `expiresAt` 미만료 + `org`이 현재 repo owner와 일치 → 라이선스 유효.
  5. **네트워크 호출 0.** revocation은 지원 안 함(만료일 내장 + §8.5 릴리스 기반 롤오버만) — C-lite 한계로 문서화.
- **canonical JSON 결정성(FIX-D1)**: 발급(`issue-license.mjs`)과 검증(`verify.js`)이 동일한 직렬화를 쓰지 않으면 서명이 깨진다. `core/canonicalJson.js`는 키를 재귀적으로 정렬하고 공백 없이 직렬화하는 단일 함수로 두고, 발급·검증·서명 산출이 전부 이 함수를 공유한다. `keyId`도 payload의 일반 필드이므로 canonical 직렬화·서명 대상에 자동 포함된다. M3 테스트에서 결정성(같은 입력 → 같은 바이트열, 키 순서 무관)을 검증한다.
- 임베드 공개키(`embeddedPublicKey.js`)는 **keyId→공개키(base64) 맵**이며, 각 값은 발급자 개인키(들)의 짝이다. **공개키만 코드에 커밋**(비밀 아님). 개인키는 발급자 로컬/발급 CI secret에만 존재(코드·문서에 넣지 않음). 이 맵은 §8.5 롤오버에서 키를 추가/제거하는 지점이다.

### 8.3 fork 우회 인정 + 유료 방어의 실질 (FIX-C1 + D-2)
- **정직 인정**: 이 Action은 OSS다. fork해서 `license/verify.js` 게이트를 삭제하거나, 개인 repo/1인 org로 owner.type을 바꾸면 로컬 게이트를 우회할 수 있다. **우리는 이를 기술적으로 막는 척하지 않는다.**
- **유료 방어의 실질(유일하게 fork로 복제 못 하는 지점)**: 유료 가치는 로컬 게이트가 아니라 **발급자 서버측 집계 파이프라인**에 있다:
  - `aggregate-report.mjs`가 **서명 없는 Evidence Record를 조직 집계 리포트에서 제외**한다(§4.2, §6.3, M4 DoD). 서명은 발급자 개인키로만 생성되고, 그 개인키는 fork·클라이언트 어디에도 없다. 따라서 fork한 Action이 무서명 레코드를 아무리 만들어도 **발급자 집계 리포트에는 들어갈 수 없다** — 이것이 fork로 복제 못 하는 유일한 지점이다.
  - 이것을 유료 방어의 실질로 명시한다. 이는 **서명을 셀링하는 것이 아니라**(D-1: "감사자가 우리 서명을 신뢰한다"류 아님), "무서명 레코드는 발급자 집계에 못 들어간다"는 **파이프라인 사실 서술**이다.
  - 조직이 이를 우회하려면 여러 repo를 가로지르는 집계·시계열 축적을 **직접 구축·운영**해야 한다(직접 구축 TCO·운영 부담). 이것이 유료의 1차 근거(D-1).
- **D-2 준수(배치·정적)**: 집계는 상시 백엔드가 아니라 **발급 시점 배치**(수동/스케줄 트리거)로만 수행. 웹훅 상주 프로세스 없음. 집계 상태는 증적 수집 repo의 정적 파일로만 존재.

### 8.4 서명은 셀링 아님 (D-1 코드 반영)
- 리포트/레코드의 서명 필드에 붙는 `note`는 항상 "변조 탐지 보조 / 감사 신뢰의 원천 아님"을 명시(§6.2 `integrity.note`).
- README 유료 섹션은 "조직 전역 집계·장기 이력·운영 아웃소싱(직접 구축 TCO 회피)"을 유료 근거로 서술. 서명을 셀링 헤드라인으로 쓰지 않는다.

### 8.5 키 교체(rotation) 경로 (발급자 개인키 유출 대응 — C-lite 롤오버)
C-lite는 네트워크 0·revocation 없음이 제약이다. 따라서 발급자 개인키가 유출돼도 실시간 폐기는 불가능하며, 대신 **릴리스 기반 키 롤오버**로 대응한다. keyId→공개키 맵(§8.2)이 이 롤오버의 기반이다.

- **시나리오**: 발급자 개인키 `k1` 유출(의심) 시.
- **절차**:
  1. **새 키쌍 `k2` 생성** — 사람이 로컬에서 생성한다(§15 경계, 예: `openssl`/Node crypto). 개인키는 발급 로컬/발급 CI secret에만.
  2. **`embeddedPublicKey.js` 맵에 `k2` 공개키 추가** — `k1`은 당분간 유지(맵에 `k1`, `k2` 병존). 이 변경을 담은 **Action 새 릴리스를 배포**(공개키 맵 추가는 코드 릴리스로만 반영됨).
  3. **이후 신규 발급은 전부 `k2`로 서명** — `issue-license.mjs`가 payload에 `keyId: "k2"`를 넣고 `k2` 개인키로 서명.
  4. **기존 `k1` 서명 라이선스는 릴리스에 `k1` 공개키가 남아있는 한 계속 검증 통과**(무중단). 조직이 기존 라이선스를 그대로 써도 서비스 중단 없음.
  5. **충분한 이행 기간 후**(예: 기존 `k1` 라이선스의 `expiresAt` 도래) 다음 릴리스에서 `embeddedPublicKey.js` 맵에서 `k1` 공개키를 **제거**하면 `k1` 서명은 전면 무효화된다.
- **C-lite 한계 정직 명시(README + §8.2 revocation 없음과 동급으로 문서화)**: 이는 **실시간 폐기(revocation)가 아니라 릴리스 기반 롤오버**다. `k1`을 즉시 무효화하려면 `k1`을 제거한 릴리스를 배포하고 조직이 그 버전으로 업데이트해야 한다. **핀 고정 버전(예: `@v2.3` 또는 커밋 SHA)** 을 계속 쓰는 조직에는 `k1` 제거가 강제되지 않는다(구버전 임베드 맵에 `k1`이 남아있으므로). 즉 롤오버의 실효성은 조직의 업데이트에 의존하며, 이는 revocation 없음(§8.2)과 동급의 C-lite 한계다.
- **issue-license.mjs 연동(§9.1)**: 발급 시 사용할 `keyId`를 입력/설정으로 받아 payload에 넣고, 그 keyId에 대응하는 개인키로 서명한다.

---

## 9. 라이선스 발급 (발급자 배치, 사람이 결제 확인 후)

### 9.1 자체 발급 스크립트 (tools/issue-license.mjs — MVP 필수)
- 입력: org 이름, plan, maxRepos, 유효기간, **keyId**(§8.5 — 어느 발급자 키로 서명할지). 발급자 개인키(env `FCP_ISSUER_PRIVATE_KEY`, 로컬/발급 CI secret).
- 동작: payload 구성(`keyId` 포함) → `core/canonicalJson.js`로 canonical JSON → 해당 keyId에 대응하는 개인키로 Ed25519 서명 → `{payload,signature}` base64 → 라이선스 문자열 출력.
- **네트워크 0, 오프라인.** 사람이 Paddle 결제 확인 후 수동 실행 → 라이선스 문자열을 고객에게 전달 → 고객이 조직 secret `FCP_LICENSE`로 등록.
- **MVP는 이 스크립트 하나로 완결**한다. keygen.sh 없이 출시 가능.

### 9.2 keygen.sh 연동 (선택 — MVP 비필수, 재확인)
- keygen.sh가 Ed25519 서명 라이선스를 발급하고, 우리는 임베드 공개키로 **로컬 검증**만 하면 C-lite 요건(네트워크 0)과 일치. keygen의 machine/validate API는 **쓰지 않는다**(네트워크 호출이므로 원칙 위반).
- Paddle 웹훅 → keygen 라이선스 발급(공식 연동)은 발급 자동화 옵션. **웹훅 수신 처리는 상시 백엔드가 아니라 서버리스 함수(Vercel/Cloudflare) 또는 keygen 내장 연동**으로 좁힌다. **MVP는 자체 스크립트(9.1)만 필수이며 keygen 관련 파일·설정을 저장소 커밋 대상에 넣지 않는다.**

> 인프라/시크릿 경계: keygen 계정·Paddle 계정 생성, 개인키 발급, 웹훅 secret 등록은 **사람의 일**(§15). 에이전트는 요청 목록만 만든다.

---

## 10. 의존성 목록 + GitHub 권한

### 10.1 npm 의존성 (오케스트레이터가 프로젝트 폴더에서 설치)
런타임(dist에 번들):
- `@actions/core`
- `@actions/github`
- `yaml`
- (Ed25519는 Node 내장 crypto — 추가 의존성 없음)

개발/빌드:
- `@vercel/ncc` (번들)
- `vitest` (테스트, v1 러너와 통일)
- `ajv` (JSON Schema 검증 테스트용)
- `@types/node` (타입, 선택)

발급 도구(`tools/`)는 런타임 번들에 포함하지 않음(별도 실행). 추가 npm 의존성 없이 Node 내장으로 구현 가능.

> Codex 샌드박스 네트워크 제한 주의: 위 의존성은 마일스톤 구현 전 오케스트레이터(사람 승인 후)가 직접 설치한다.

### 10.2 필요한 GitHub 권한 (Action 런타임)
- `contents: read` — 워크플로 파일·diff 읽기.
- `pull-requests: read` — PR diff, reviews(codeowner fallback).
- `checks: read` — R-4 보조 교차확인(head SHA check-runs 조회). write는 불필요(v1 마커 방식 유지 시 별도).
- `statuses: write` 또는 required check 통합 방식은 v1 방식 유지.
- branch protection 조회(§5.2 보조)는 `GITHUB_TOKEN` 기본 권한으로 **거의 항상 403**(admin 필요) → 추가 권한을 요구하지 않고, 성공 시에만 stale 경고 보조로 쓴다(입력값이 1차 소스).
- 증적 수집 repo의 `collect-evidence.yml`은 대상 repo 아티팩트 다운로드에 org read 범위 필요 → 조직이 제공하는 PAT/GitHub App 토큰을 secret으로(발급자 아님, 조직 자체 자원). 또한 다운로드한 원본 레코드를 자기 repo에 커밋해야 하므로 `contents: write`(자기 repo)가 필요하다. 이는 D-2/D-3 내 조직 소유 자원.

---

## 11. 로컬 개발·테스트 (docker-compose 미채택 — FIX-D1)

이 프로젝트는 런타임에 DB/Redis가 없다(상태 없음 원칙). 따라서 **docker-compose.yml을 두지 않는다**(상태 없는 검사기에 과잉·유지비만 늘고 가치 낮음).

- 로컬 테스트 재현: Node 20 + `npm ci && npm test`로 충분. CI는 GitHub Actions 매트릭스(Node 20)로 동일 환경 재현.
- 라이선스/발급 테스트용 환경변수는 로컬 `.env`(gitignore)로 주입: `FCP_LICENSE`, `FCP_ISSUER_PRIVATE_KEY`(테스트 키). 시크릿 값은 커밋 금지, `.env.example`에 이름만.
- (근거) DB/Redis 등 상태 백엔드가 없으므로 컨테이너 오케스트레이션이 불필요하다. 로컬-CI 환경 일치는 Node 버전 고정(`.nvmrc`/`engines`)으로 달성한다.

---

## 12. 마일스톤 분해

각 마일스톤은 독립적으로 완성·테스트 가능하며, 끝날 때 git commit. 마일스톤 순서는 의존성 순(무료 코어·파서 → 유료 탐지 → 라이선스 → 집계).

### M1 — 무료 코어 개선 + 워크플로 파서 기반 (무료)
**범위**: `core/workflowParser.js`(YAML 파싱·job/스텝 스코프·라인 매핑·check이름 매핑 기반), P1-1 allowlist(§7.1), P1-2 allowJobs 실적용(§7.2), P3-6·7 ratchet 정교화·억제이유 검증(§7.4), P3-5 CODEOWNER team fallback(§7.3, 기본 off).
**DoD**:
- `workflowParser`가 `.github/workflows/*.yml`를 파싱해 job id/name/if/on + 스텝 라인 매핑 + §5.3 check이름 매핑(일반·matrix·동적name·reusable 구분)을 반환한다.
- continue-on-error allowlist(입력 목록 + 인라인 주석) 예외가 검출기4에 적용되어, 등록된 스텝은 error로 안 잡히고 미등록은 잡힌다.
- allowJobs가 실제 라인→job 매핑으로 적용되어 `experimental-nightly` job의 히트가 제외된다(dead config 해소).
- ratchet: base 대비 실행수 급감이 "확인 요청" 메시지로 구분되고, baseline 갱신 경로로 통과 가능. 억제 이유 없는 것 hard cap / 있는 것 soft cap 2단 동작.
- codeownerTeamFallback=false일 때 v1 fail-closed 유지, true일 때만 author_association fallback 동작.
**테스트**:
- 파서 단위 테스트: matrix job 이름 확장(include/exclude 반영), job-level if 추출, on paths 추출, reusable `uses` 감지, 동적 name 감지.
- allowlist: 등록/미등록 스텝 각각 fixture 워크플로로 pass/fail 검증.
- ratchet: 210→40 급감 fixture fail, baseline 갱신 fixture pass. 이유 없는 억제 hard cap fail.
- D-1/D-2/D-3 자가검증: 이 마일스톤은 무료 코어라 라이선스·집계 없음 확인.

### M2 — required job skip=success 탐지 + Evidence Record 산출 (무료 탐지)
**범위**: `detectors/requiredJobSkip.js`(§5 R-1~R-5), `core/evidenceRecord.js`(§6.1 스키마 직렬화 + 아티팩트 업로드), `schemas/evidence-record.schema.json`.
**DoD**:
- required job에 명백한 skip 유발 `if:` 신규(R-2 skip_risk), job 소멸/개명(R-1 확정 매핑), on 트리거 축소(R-3), `requiredJobs` 입력 축소(R-5)를 각각 base↔head diff로 탐지해 hard-fail + Evidence Record `attempts[]`에 기록.
- 애매한 조건부 `if:`는 hard-fail이 아니라 `required_job_if_added_review`(severity review) 경고+기록.
- 정당 조건부 패턴(`success()`/`needs.*.result`/`event_name=='push'`/`ref=='refs/heads/main'`/`always()`·`!cancelled()` 단독)은 pass.
- 매핑 불확정(외부 reusable / 동적 name / 같은 repo reusable 파싱 실패)은 R-1 hard-fail 대신 `mapping_unresolved` 경고(`weakenings[]`).
- `requiredJobs` **미지정** + branch protection 조회 실패 시에만 정보성 강등. **입력이 있었는데 축소**된 경우는 강등 아니라 R-5 hard-fail.
- 매 run이 Evidence Record(JSON)를 스키마에 맞게 산출하고 `upload-artifact`로 저장. 라이선스 없으면 `license.org=false`, `signature=null`.
- Evidence Record가 `schemas/evidence-record.schema.json` 검증을 통과.
- README에 "탐지가 잡는 것 / 못 잡는 것"(§5.4 목록) 명시(정직 한계).
**테스트 (FIX-B2/D1 난제 fixture 명시 포함)**:
- fixture: required job에 `if: github.actor != 'x'` 추가 → hard-fail `required_job_if_skip_risk`.
- fixture: required job의 name 변경(확정 매핑) → hard-fail `required_job_missing`.
- fixture: `on.pull_request`에 `paths-ignore` 확대 → hard-fail `required_workflow_trigger_narrowed`. 경계 glob은 보수적 fail + "수동 확인 요망".
- fixture: `with.requiredJobs` 입력 base=`"test,lint"` → head=`"test"` 축소 → hard-fail `required_config_narrowed`.
- **fixture (reusable)**: required check `deploy / build`가 (a)같은 repo reusable → concat 재구성으로 매핑 확정, 그 job 소멸 시 R-1 fail / (b)외부 repo reusable → `mapping_unresolved` 경고(오탐 fail 없음).
- **fixture (matrix include/exclude)**: base matrix가 `os: [ubuntu, windows]`인데 head가 `exclude: windows`로 조합 축소 → 해당 조합 R-1 fail. 조합 추가(정당) → pass.
- **fixture (동적 name)**: `name: ${{ matrix.os }}-build` → 정적 확정 불가 → `mapping_unresolved` 경고(오탐 fail 없음).
- fixture (정당 조건부): `if: github.ref == 'refs/heads/main'` 추가 → pass(오탐 없음). `if: success() && needs.build.result == 'success'` → pass.
- fixture (애매): `if: vars.RUN_LINT == 'true'` 추가 → `required_job_if_added_review`(경고+기록, hard-fail 아님).
- 각 fixture가 **오탐(정당 케이스 pass)과 탐지(공격 케이스 fail/경고)를 동시에 만족**하는지 검증.
- Evidence Record JSON Schema 검증 테스트.
- D-1 자가검증: 이 단계에서 서명은 채우지 않음(무료), 서명 셀링 문구 없음.

### M3 — C-lite 라이선스 검증 + 개인/조직 게이트 + 키 롤오버 (유료 게이트, honor-system)
**범위**: `license/verify.js`, `license/embeddedPublicKey.js`(keyId→공개키 맵), `core/canonicalJson.js`, `tools/issue-license.mjs`(keyId 지정 발급), Evidence Record 서명 필드 채움(조직+라이선스 시), 개인/조직 판별(§8.1), 키 롤오버 경로(§8.5).
**DoD**:
- `core/canonicalJson.js`가 결정적 직렬화(키 재귀 정렬·공백 없음)를 제공하고, 발급·검증·서명이 모두 이를 공유. `keyId`도 payload 필드로 직렬화·서명 대상에 포함.
- `license/embeddedPublicKey.js`가 **keyId→공개키(base64) 맵**이고, `verify`가 payload의 `keyId`로 공개키를 조회해 검증하며 **미등록 keyId는 거부**한다(§8.2).
- `issue-license.mjs`가 keyId를 입력으로 받아 payload에 넣고 그 keyId 개인키로 라이선스 문자열을 발급하며, `verify.js`가 임베드 맵에서 keyId로 조회한 공개키로 **네트워크 0** 검증(서명·만료·org 일치)한다.
- 개인 계정(owner.type=User) repo: 라이선스 없이 전 기능(탐지·무서명 Evidence Record) 동작. 유료 산출만 비활성.
- 조직 계정(owner.type=Organization) repo + 유효 라이선스: Evidence Record에 `license.org=true` + `signature`(`keyId` 포함) 채움(Ed25519, 무결성 보조).
- 조직 + 라이선스 없음/만료/불일치/미등록 keyId: 탐지·무서명 레코드는 계속 동작(무료 방어 훼손 금지), 서명 필드만 비활성 + 경고.
- README에 owner.type 게이트가 **honor-system(기술 강제 아님)이며 1인 org·개인 repo·fork로 우회 가능**함을 정직 명시(§8.1). 유료 방어의 실질=발급자 집계 파이프라인(무서명 레코드 집계 제외)임을 서술(§8.3). **키 롤오버가 실시간 revocation이 아니라 릴리스 기반이며 핀 고정 버전에는 강제되지 않음**을 C-lite 한계로 명시(§8.5).
**테스트**:
- **canonical JSON 결정성 테스트**: 같은 객체를 키 순서 다르게 넣어도 동일 바이트열 산출. 발급→검증 왕복 서명 일치. `keyId`가 순서 무관하게 동일 직렬화에 포함됨.
- 유효 서명 검증 pass / 변조 payload 검증 fail / 만료 라이선스 fail / org 불일치 fail.
- **키 롤오버 테스트(§8.5)**:
  - **구키(k1) 서명 라이선스가 맵에 k1이 있는 한 계속 검증 통과** — 맵 `{k1,k2}` 상태에서 k1 서명 라이선스 pass.
  - **미등록 keyId(맵에 없는 keyId) 라이선스는 검증 거부** — 예: payload `keyId:"k9"`인데 맵에 k9 없음 → fail.
  - **keyId가 서명 대상에 포함되어 keyId 변조 시 서명 검증 실패** — 서명 후 payload의 keyId를 다른 값으로 바꾸면 서명 검증 fail.
- 개인 계정 컨텍스트 fixture: 라이선스 없이 동작 + 서명 없음.
- 조직 컨텍스트 + 유효 라이선스: 서명 필드 존재(`keyId` 포함).
- 검증 경로에 네트워크 호출 없음(테스트에서 fetch/http 미사용 assert).
- D-1 자가검증: 서명 note 문구가 "무결성 보조·감사 신뢰 원천 아님"으로 존재. 서명 셀링 헤드라인 없음. owner.type 과대 서술 없음(honor-system).

### M4 — Organization Evidence Report 집계 생성기 + 레코드 장기 보존 (유료 산출, 배치)
**범위**: `tools/aggregate-report.mjs`(커밋 레코드 저장소 소스 재집계 지원), `schemas/org-evidence-report.schema.json`, `evidence-repo-template/.github/workflows/collect-evidence.yml`(원본 레코드 커밋 보존 + 수집 주기 경고 주석), 리포트 Markdown 렌더.
**DoD**:
- `aggregate-report.mjs`가 여러 Evidence Record(JSON) 입력을 받아 §6.2 스키마의 조직 리포트(JSON + Markdown)를 **정적 파일**로 생성.
- 조직 라이선스 검증 통과 시에만 집계 수행(없으면 거부). **서명 없는 레코드는 집계에서 제외 + 경고 카운트**(§8.3 유료 방어 실질).
- **`collect-evidence.yml`이 다운로드한 원본 Evidence Record를 증적 repo에 커밋해 보존한다(리포트만이 아니라)**. 경로 `evidence-records/<repo>/<YYYY>/<PR>-<headSha>.json`(§4.2). 재집계는 **커밋된 레코드 저장소를 소스로** 할 수 있다.
- **수집 주기가 아티팩트 보존 기간보다 짧아야 한다는 경고가 `collect-evidence.yml` 템플릿 주석 + README 증적 수집 안내에 모두 있다**(§6.3). 기본 스케줄(주 1회) vs 기본 아티팩트 보존(90일) 관계 + 조직이 보존을 짧게 설정했을 때의 위험 서술 포함.
- 시계열(주별), 반복 시도자, 반복 repo, byKind 집계가 fixture 레코드 집합에서 정확히 계산됨.
- 리포트 파일 Ed25519 서명(무결성 보조) + `integrity.note`/`compliance.note`가 D-1 문구로 존재.
- `compliance.mappingHint`가 "evidence input only / 통제 이행 증명 아님 / 감사자 평가 대체 아님"으로 표기(권고 D-1-m). README도 동일 규칙 문구 포함.
- `collect-evidence.yml`이 `workflow_dispatch`/schedule로만 트리거(상시 아님, D-2) — 상주 프로세스·웹훅 없음.
- 리포트가 `schemas/org-evidence-report.schema.json` 검증 통과.
**테스트**:
- fixture 레코드 20개(여러 repo·actor·주차) → 집계 결과의 totalAttempts/timeSeries/repeatActors/repeatRepos 값 정확성 검증.
- **재집계 재현 테스트(레코드 장기 보존)**: `aggregate-report.mjs`가 **커밋된 레코드 디렉토리(fixture)** 를 소스로 재집계해 아티팩트 없이도 동일 결과를 낸다(커밋 레코드만으로 재현 가능함 검증).
- 라이선스 없이 집계 시도 → 거부.
- 서명 없는 레코드 혼입 → 제외 + 경고 카운트.
- 리포트 JSON Schema 검증.
- **(주의) 실제 여러 repo 아티팩트 수집·커밋(EVIDENCE_COLLECT_TOKEN·org read PAT)은 조직 자원이라 M4 테스트는 로컬 fixture 레코드로만 검증**한다(실 아티팩트 수집·커밋은 조직 자원). 실 org 수집은 사람 자원 준비 후(§15).
- D-1/D-2/D-3 자가검증: aggregationScope=static-batch, 단일 파일 산출, 커밋 레코드 저장소도 단일 repo 내 정적 파일(상태 DB 아님), 서명 셀링 문구 부재, 상주 프로세스 부재, SOC2 매핑 과대 포지셔닝 문구 부재.

각 마일스톤 완료 시: README 해당 섹션 갱신 + git commit + `.env.example` 갱신(키 이름만).

---

## 13. 완료 기준 (Definition of Done)

- M1~M4 전 마일스톤의 DoD·테스트가 통과한다(검증 verifier PASS).
- README가 다음을 포함한다:
  - 무료/유료 경계 표(§2) + 경계의 성격(honor-system이며 유료 실질은 발급자 집계 파이프라인).
  - required job skip=success 탐지가 **무엇을 잡고 무엇을 못 잡는지**(§5.4 정직 한계 목록 — 외부 reusable·동적 name·step-level if 미탐 명시).
  - 개인 무료 / 조직 라이선스 안내(Gitleaks 모델), 라이선스 등록법(`FCP_LICENSE` secret), **owner.type 게이트가 honor-system이며 우회 가능함 정직 명시**.
  - **키 롤오버(§8.5)가 릴리스 기반이며 실시간 revocation이 아니고 핀 고정 버전에는 강제되지 않음**(C-lite 한계).
  - `requiredJobs` 입력값이 실제 branch protection과 동기화됨은 **사용자 책임**임을 명시.
  - fork 우회 정직 인정 + 유료 가치가 "조직 집계·이력·운영 아웃소싱(TCO 회피)"에 있음(D-1 준수, 서명 셀링 금지).
  - SOC2/ISO 매핑은 "evidence input 힌트일 뿐 통제 이행 증명이 아니다"(권고 D-1-m).
  - **증적 수집 안내: 수집 주기가 아티팩트 보존 기간보다 짧아야 함 + 원본 레코드가 증적 repo에 커밋 보존됨**(§6.3, §4.2).
  - 실행 방법: Action 사용 예시 워크플로 + 증적 수집 repo 설정법 + 집계 리포트 생성법.
- `.env.example`에 키 이름만(값 없음): `FCP_LICENSE`, `FCP_ISSUER_PRIVATE_KEY`(발급 도구용), 필요 시 `EVIDENCE_COLLECT_TOKEN`.
- `.gitignore`에 `.env` 포함.
- 로컬 테스트가 `npm ci && npm test`로 재현된다(docker-compose 불필요 — §11).
- D-1/D-2/D-3 자가검증 항목이 각 마일스톤에서 통과(설계 red-team 재검토용).

---

## 14. 비목표 (Non-goals — 명시 제외)

- **App 전환 금지**: GitHub App으로의 전환(웹훅 수신·설치 상태·상태 있는 백엔드)은 v2 범위 밖. 순수 Action + C-lite 라이선스 유지.
- **실시간 조직 대시보드 금지**: 조직 전역 실시간 상태 저장/대시보드/상태 DB를 두지 않는다(D-3). 집계는 단일 repo 정적 아티팩트만. (커밋된 원본 레코드 저장소도 단일 repo 내 정적 파일이며 상태 DB가 아니다.)
- **상시(always-on) 백엔드 금지**: 라이선스 검증·집계는 발급 시점 배치/로컬. 상주 서버·웹훅 상주 프로세스 없음(D-2). (Paddle→keygen 웹훅 연동을 두더라도 서버리스 함수/keygen 내장으로 좁히고 MVP 필수 아님.)
- **런타임 네트워크 호출 금지**: Action 런타임은 `GITHUB_TOKEN` API 외 외부 네트워크 0. keygen validate API 등 라이선스 서버 런타임 호출 안 함.
- **서명을 유료 셀링포인트로 삼지 않음(D-1)**: 서명은 산출물 무결성 보조로만. owner.type 게이트를 "기술적 방어"로 과대 서술하지 않음(honor-system).
- **revocation 실시간 지원 안 함**: C-lite 한계. 만료일 내장 + 릴리스 기반 키 롤오버(§8.5)만. 실시간 폐기 아님(문서화).
- **단일 repo 탐지 유료화 안 함**: 단일 repo 방어는 전부 무료(무료 대안과 정면 비교 회피).
- **fork/1인 org 우회를 기술로 막지 않음**: honor-system으로 인정하고, 방어는 발급자 집계 파이프라인으로만.

---

## 15. 사람이 준비할 것 (외부 자원·시크릿·환경변수)

> CLAUDE.md 인프라/시크릿 경계: 아래는 전부 사람이 수행. 에이전트는 요청 목록만 만든다. 시크릿 값은 문서·코드에 넣지 않는다(이름만).

### 15.1 생성할 외부 자원
- **Paddle 계정(MoR)**: 한국 개인사업자 글로벌 라이선스 판매용. 심사에 사업자등록증·서비스 URL·영문 T&C/환불정책 필요(1~2주). 대안 Polar.
- **keygen.sh 계정(선택·MVP 비필수)**: Ed25519 서명 라이선스 발급 자동화용. 우리는 로컬 검증만 하므로 발급 측만 필요. MVP는 자체 `issue-license.mjs`로 대체(계정 없이 출시 가능).
- **제품 랜딩 페이지**: README → 랜딩 → MoR 체크아웃 3단(정적 페이지, Vercel/Cloudflare Pages 권장 — "왜 지금 필요한지": 결제 유입 퍼널의 중간 단계이자 유료 가치 서술 지점).
- **증적 수집 repo(조직이 만듦)**: 조직 고객이 자기 org에 `ci-evidence` repo 생성(D-3 단일 repo 경계). 우리 자원 아님.

### 15.2 발급할 시크릿 (사람이 발급, 값은 코드/문서에 금지)
- **발급자 Ed25519 키쌍**: 발급자 개인키(`FCP_ISSUER_PRIVATE_KEY`)는 발급 로컬/발급 CI secret에만. 짝 공개키는 `license/embeddedPublicKey.js`의 keyId→공개키 맵 + `tools/keygen-public.pem`에 커밋(공개키는 비밀 아님). **키 생성은 사람이 수행**(예: `openssl`/Node crypto로 로컬 생성). **키 교체(§8.5) 시 새 키쌍(k2 등) 생성도 사람의 일**이며, 새 공개키를 맵에 추가하는 것은 **코드 릴리스로 반영**된다(에이전트가 직접 키를 만들지 않음).
- **조직 라이선스 문자열**: 결제 확인 후 발급자가 `issue-license.mjs`로 생성(발급 시 사용할 keyId 지정) → 고객 조직이 `FCP_LICENSE` secret으로 등록.
- **(선택) Paddle 웹훅 secret / keygen API 키**: keygen 연동 시. MVP 불필요.

### 15.3 배포 플랫폼에 등록할 환경변수 (이름만)
- 랜딩/서버리스(선택, Vercel/Cloudflare): `PADDLE_WEBHOOK_SECRET`, `KEYGEN_API_TOKEN`(keygen 연동 시). MVP 미사용 가능.
- 발급 CI(선택): `FCP_ISSUER_PRIVATE_KEY`(발급 스크립트용, 발급 CI secret).
- 조직 고객 repo: `FCP_LICENSE`(조직 라이선스), `EVIDENCE_COLLECT_TOKEN`(증적 수집 repo가 org 아티팩트 다운로드용 — 조직 자체 PAT/App 토큰).

### 15.4 GitHub 설정 (사람)
- Marketplace 리스팅 갱신(v2 기능·무료/유료 안내). Action은 무료 게시 유지, 과금은 C-lite 라이선스로(Marketplace 과금 아님).
- 조직 고객 측 브랜치 보호 required status check 지정(실제 강제력의 원천 — v1과 동일).
- 조직 고객 측 `with.requiredJobs` 입력값을 실제 required check 목록과 동기화(사용자 책임 — §5.2).
- 조직 고객 측 증적 수집 repo의 아티팩트 보존 기간을 확인하고, 수집 주기를 그보다 짧게 유지(레코드 유실 방지 — §6.3).

---

## 부록 A. D-1/D-2/D-3 + FIX 준수 체크리스트 (설계 red-team 재검증용)

- [ ] D-1: 유료 근거 서술이 전부 "집계·이력·TCO·운영 아웃소싱"에 있고, 서명은 §6.2 `integrity.note`/§8.4대로 무결성 보조로만. README/문구에 "감사자가 우리 서명을 신뢰한다"류 없음. owner.type을 기술 방어로 과대 서술하지 않음(honor-system).
- [ ] D-2: 집계는 발급 시점 배치(`workflow_dispatch`/schedule/로컬)만. 상시 백엔드·웹훅 상주 없음. fork 방어 논거 = 발급자 집계 파이프라인(무서명 레코드 집계 제외), 서명 셀링 아님.
- [ ] D-3: 조직 집계는 단일 증적 수집 repo의 정적 파일(`aggregationScope: static-batch`). 커밋된 원본 레코드 저장소도 단일 repo 내 정적 파일(상태 DB 아님). 실시간 대시보드·상태 DB 없음.
- [ ] v1 원칙: 런타임 네트워크 0(라이선스 로컬 검증, GITHUB_TOKEN 외 호출 없음), 상태 없음, 결정적.
- [ ] FIX-B1: `requiredJobs` 입력 1차 소스 + API 보조(성공 시 stale 경고) + R-5 입력 축소 hard-fail + 강등 분기(미지정=강등 / 축소=fail).
- [ ] FIX-B2: check이름 매핑 규칙(reusable concat·외부 reusable 불확정 경고·동적 name 경고·matrix include/exclude 델타) 명세 + "못 잡는 것" README.
- [ ] FIX-B3: R-2가 skip 유발 if만 hard-fail, 정당 조건부 오탐 억제, 애매한 것은 경고+기록.
- [ ] FIX-C1: owner.type honor-system 정직 격하 + 유료 실질=발급자 집계 파이프라인(무서명 제외) 서술.
- [ ] FIX-D1: M2에 reusable/matrix/동적name fixture 명시, M3 canonical JSON 결정성 테스트, docker-compose 삭제.
- [ ] 키 롤오버(§8.5): embeddedPublicKey가 keyId→공개키 맵, verify가 payload.keyId로 조회·미등록 keyId 거부, keyId가 서명 대상에 포함, 롤오버가 릴리스 기반(실시간 revocation 아님·핀 고정 버전 한계) 문서화. M3 테스트에 구키 계속 통과 + 미등록 keyId 거부 + keyId 변조 검증 실패 포함.
- [ ] 레코드 장기 보존(§4.2/§6.3): collect-evidence가 원본 레코드를 증적 repo에 커밋 보존, 재집계는 커밋 레코드 저장소 소스, 수집 주기 < 아티팩트 보존 경고가 템플릿 주석 + README에 있음. M4 테스트에 커밋 레코드 fixture 재집계 재현 포함.
- [ ] 권고: SOC2 매핑 "evidence input only" 문구, keygen MVP 비필수 재확인.
```
