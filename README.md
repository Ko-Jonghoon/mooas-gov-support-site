# 무아스 정부지원사업 매칭 사이트

회사 조건을 입력하면 정부·지자체·공공기관 지원사업을 자동으로 매칭해 추천하는 정적 웹사이트입니다.
Claude Artifact 프로토타입에서 시작해, **API로 자동 업데이트되는 실제 사이트**로 확장한 버전입니다.

## 구성

```
index.html                 # 화면 (Claude Artifact와 동일한 UI, JSON을 fetch해서 렌더링)
data/policies.json          # 지원사업 데이터 (32건 수동 시드 + 자동 수집분)
scripts/fetch-and-tag.mjs   # 기업마당 Open API → 키워드 규칙 기반 자동 태깅 → policies.json 갱신
.github/workflows/
  update-policies.yml       # 매일 자동 수집 + PR 생성 (사람 검수용)
  deploy-pages.yml          # main 브랜치 push 시 GitHub Pages 배포
```

`scripts/fetch-and-tag.mjs`는 Node.js 내장 기능(fetch, fs)만 사용해서 별도 npm 설치가 필요 없습니다.

## 지금 당장 확인하기 (로컬)

```sh
npx serve .
# 브라우저에서 http://localhost:3000 접속
```

`index.html`을 더블클릭해서 `file://`로 직접 열면 `fetch('./data/policies.json')`이
브라우저 보안 정책 때문에 막힙니다. 반드시 로컬 서버(`npx serve .`, `python -m http.server` 등)로 열어야 합니다.

## 자동 업데이트를 켜기까지 남은 단계

### 1. 기업마당(bizinfo.go.kr) Open API 키 신청

**회원가입 불필요, 신청 즉시 발급됩니다.**

1. [bizinfo.go.kr/apiList.do](https://www.bizinfo.go.kr/apiList.do) 접속 (상단 메뉴: 활용정보 → 정책정보 개방)
2. 목록에서 **"지원사업정보 API"** 클릭
3. 상세 페이지 맨 아래 **"신청하기"** 버튼 클릭
4. 기관명·신청자명·이메일·전화번호·시스템명·시스템 IP(또는 URL) 입력 후 제출
5. **그 자리에서 인증키가 즉시 발급**되고 입력한 이메일로도 전송됩니다

발급받은 키가 `crtfcKey` 값이며, 그대로 `BIZINFO_API_KEY` GitHub Secret에 넣으면 됩니다.

확인된 API 스펙(`scripts/fetch-and-tag.mjs`에 이미 반영):
- `GET https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do`
- 필수: `crtfcKey` / 선택: `dataType`(json/rss), `searchCnt`, `searchLclasId`(분야 01~09), `hashtags`, `pageUnit`, `pageIndex`
- 다만 JSON 응답의 정확한 배열 경로(예: `jsonArray`)와 필드명(공고명/기관명/URL 등)은 실제 키로 한 번 호출해보고
  `fetchRawAnnouncements()`와 `pickField()`에 넘기는 후보 필드명 목록을 필요시 조정하세요.

(선택) [K-Startup Open API](https://www.k-startup.go.kr)도 같은 방식으로 별도 신청해 데이터 소스를 늘릴 수 있습니다.

### 2. GitHub 저장소 만들기 + Secrets 등록

1. 이 폴더(`mooas-gov-support-site`)를 새 GitHub 저장소로 push
2. 저장소 **Settings → Secrets and variables → Actions → New repository secret**
   - `BIZINFO_API_KEY` — 1번에서 발급받은 키
3. **Settings → Pages**에서 Source를 "GitHub Actions"로 설정

### 3. 동작 확인

- `.github/workflows/update-policies.yml`을 Actions 탭에서 수동 실행(workflow_dispatch)해보면 `data/policies.json`을 갱신한 PR이 자동으로 열립니다.
- PR 내용을 검토(자격요건·혜택 내용이 실제 공고와 맞는지 확인)한 뒤 병합하면, `deploy-pages.yml`이 자동으로 사이트를 재배포합니다.

## 태깅 방식: 키워드 규칙 기반 (LLM 미사용)

공고 원문(제목/사업개요/지원대상/해시태그)에서 특정 키워드를 찾아 우리 스키마(업종/지역/기업구분/인증/대표자특성 등)로 자동 변환합니다.
예: "청년창업" → 청년대표, "제조업" → 업종 mfg, "업력 5년 이내" → maxYears: 5.
규칙은 `scripts/fetch-and-tag.mjs`의 `CATEGORY_RULES`, `FOUNDER_TYPE_RULES` 등의 배열에 있으며, 키워드를 추가/수정하면 바로 반영됩니다.

**LLM 태깅보다 정확도가 낮을 수 있습니다** — 키워드가 없으면 놓치고, 문맥 이해 없이 단순 매칭이라 오탐도 있을 수 있습니다.
그래서 모든 자동 수집 항목은 `reviewed: false`로 표시되어 사이트에 "자동수집 · 검수대기" 배지가 붙고,
GitHub Actions도 바로 반영하지 않고 **PR을 생성**해 사람이 검토 후 병합하도록 만들어져 있습니다.

## 앞으로 더 고려할 것

- 규칙에 없는 키워드가 많이 보이면 `CATEGORY_RULES` 등에 키워드 추가
- 중복 공고 감지 정교화 (현재는 이름+기관 기준으로 자동 수집분만 매번 새로 만듦)
- 마감된 공고 자동 제거
- K-Startup 등 추가 데이터 소스 통합
- 나중에 정확도를 높이고 싶어지면 Claude API 기반 태깅으로 다시 전환 가능 (이전 버전 로직 참고)
