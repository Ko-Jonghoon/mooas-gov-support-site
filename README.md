# 무아스 정부지원사업 매칭 사이트

회사 조건을 입력하면 정부·지자체·공공기관 지원사업을 자동으로 매칭해 추천하는 정적 웹사이트입니다.
Claude Artifact 프로토타입에서 시작해, **API로 자동 업데이트되는 실제 사이트**로 확장한 버전입니다.

## 구성

```
index.html                 # 화면 (Claude Artifact와 동일한 UI, JSON을 fetch해서 렌더링)
data/policies.json          # 지원사업 데이터 (32건 수동 시드 + 자동 수집분)
scripts/fetch-and-tag.mjs   # 기업마당 Open API → Claude 자동 태깅 → policies.json 갱신
.github/workflows/
  update-policies.yml       # 매일 자동 수집 + PR 생성 (사람 검수용)
  deploy-pages.yml          # main 브랜치 push 시 GitHub Pages 배포
```

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
- 다만 JSON 응답의 정확한 배열 경로(예: `jsonArray`)는 실제 키로 한 번 호출해보고 `fetchRawAnnouncements()`의 마지막 줄을 필요시 조정하세요.

(선택) [K-Startup Open API](https://www.k-startup.go.kr)도 같은 방식으로 별도 신청해 데이터 소스를 늘릴 수 있습니다.

### 2. Anthropic API 키 준비

[console.anthropic.com](https://console.anthropic.com)에서 API 키를 발급받으세요. 이 키가 각 공고 원문을 우리 매칭 스키마(업종/지역/인증/체납여부 등)로 자동 태깅하는 데 쓰입니다.

### 3. GitHub 저장소 만들기 + Secrets 등록

1. 이 폴더(`mooas-gov-support-site`)를 새 GitHub 저장소로 push
2. 저장소 **Settings → Secrets and variables → Actions**에서 등록:
   - `BIZINFO_API_KEY` — 1번에서 발급받은 키
   - `ANTHROPIC_API_KEY` — 2번에서 발급받은 키
3. **Settings → Pages**에서 Source를 "GitHub Actions"로 설정

### 4. 동작 확인

- `.github/workflows/update-policies.yml`을 Actions 탭에서 수동 실행(workflow_dispatch)해보면 `data/policies.json`을 갱신한 PR이 자동으로 열립니다.
- PR 내용을 검토(자격요건·혜택 내용이 실제 공고와 맞는지 확인)한 뒤 병합하면, `deploy-pages.yml`이 자동으로 사이트를 재배포합니다.

## 왜 PR 방식인가요? (자동 병합하지 않는 이유)

기업마당 API는 공고 "원문 텍스트"만 줄 뿐, 우리 시스템이 쓰는 "업종/지역/인증/체납여부" 같은 구조화된 조건으로는 오지 않습니다.
그래서 Claude가 원문을 읽고 구조화된 조건으로 태깅하는데, **LLM 태깅은 항상 100% 정확하지 않을 수 있습니다.**
그래서 자동 수집 → 사람이 PR을 검토 → 병합 시에만 실제 사이트에 반영, 이라는 흐름으로 설계했습니다.
검수를 거치지 않은 항목은 카드에 "자동수집 · 검수대기" 배지가 붙어 사용자에게도 투명하게 표시됩니다.

## 비용 관련

- 자동 태깅은 기본적으로 `claude-opus-5` 모델을 사용합니다(정확도 우선).
- 공고 건수가 많아 비용을 낮추고 싶다면, GitHub Actions의 `update-policies.yml`에 `ANTHROPIC_MODEL: claude-haiku-4-5` 같은 환경변수를 추가해 더 저렴한 모델로 전환할 수 있습니다.
- 매일 실행 대신 주 1회 등으로 스케줄(cron)을 바꿔 API 호출 빈도를 줄일 수도 있습니다(`update-policies.yml`의 `cron` 값 수정).

## 앞으로 더 고려할 것

- 중복 공고 감지(같은 사업이 여러 번 자동수집되지 않도록 이름+기관 기준 병합 로직을 이미 넣었지만, 정교화 여지 있음)
- 마감된 공고 자동 제거
- K-Startup 등 추가 데이터 소스 통합
