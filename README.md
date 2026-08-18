# 무아스 정부지원사업 매칭 사이트

회사 조건을 입력하면 정부·지자체·공공기관 지원사업을 자동으로 매칭해 추천하는 정적 웹사이트입니다.
Claude Artifact 프로토타입에서 시작해, **API 데이터로 갱신 가능한 실제 사이트**로 확장한 버전입니다.

## 구성

```
index.html                 # 화면 (Claude Artifact와 동일한 UI, JSON을 fetch해서 렌더링)
data/policies.json          # 지원사업 데이터 (32건 수동 시드 + 자동 수집분)
data/rnd-history.json       # NTIS 국가R&D 과제 이력 데이터 ("R&D 이력" 탭 전용, 공고 목록과 무관)
scripts/fetch-and-tag.mjs   # 기업마당 Open API → 키워드 규칙 기반 자동 태깅 → policies.json 갱신
scripts/fetch-ntis.mjs      # NTIS 국가R&D 과제검색 API → rnd-history.json 갱신
.github/workflows/
  deploy-pages.yml          # main 브랜치 push 시 GitHub Pages 배포 (자동)
```

`scripts/fetch-and-tag.mjs`는 Node.js 내장 기능(fetch, fs)만 사용해서 별도 npm 설치가 필요 없습니다.

## 지금 당장 확인하기 (로컬)

```sh
npx serve .
# 브라우저에서 http://localhost:3000 접속
```

`index.html`을 더블클릭해서 `file://`로 직접 열면 `fetch('./data/policies.json')`이
브라우저 보안 정책 때문에 막힙니다. 반드시 로컬 서버(`npx serve .`, `python -m http.server` 등)로 열어야 합니다.

## 데이터 갱신은 왜 수동인가요?

원래는 GitHub Actions(해외 클라우드 서버)에서 매일 자동으로 기업마당 API를 호출하도록 만들었지만,
**기업마당이 해외/클라우드 IP 대역의 접속을 막고 있어서** GitHub Actions에서는 연결 자체가 타임아웃 납니다.
반면 한국 인터넷(회원님 PC)에서는 정상적으로 호출됩니다.

그래서 데이터 수집은 **회원님 PC에서 직접 실행**하고, 그 결과만 GitHub에 올리는 방식으로 운영합니다.
사이트 배포(`deploy-pages.yml`)는 여전히 자동입니다 — `main`에 push하면 몇 분 안에 실제 사이트에 반영됩니다.

## 데이터 갱신하는 방법 (필요할 때, 예: 주 1회)

1. **기업마당 인증키 발급**받기 — 아직 없다면 아래 "기업마당 API 키 신청" 참고
2. PowerShell 열고:
   ```powershell
   cd "C:\Users\user\Desktop\mooas-gov-support-site\scripts"
   $env:BIZINFO_API_KEY="발급받은 인증키 값"
   node fetch-and-tag.mjs
   ```
3. `기업마당에서 N건의 공고를 가져왔습니다` / `data/policies.json 갱신 완료: ...` 메시지 확인
4. **GitHub Desktop**을 열어 `data/policies.json` 변경 내용 확인
   - `source: "auto"`, `reviewed: false`로 표시된 새 항목들이 실제 공고와 맞는지 몇 개 훑어보기
   - 이상한 항목은 그 자리에서 파일을 직접 열어 수정해도 됩니다 (VS Code, 메모장 등으로 `data/policies.json` 편집)
5. GitHub Desktop에서 **Commit → Push**
6. 몇 분 뒤 실제 사이트(GitHub Pages 주소)에 새 데이터가 반영됩니다

## 기업마당(bizinfo.go.kr) Open API 키 신청

**회원가입 불필요, 신청 즉시 발급됩니다.**

1. [bizinfo.go.kr/apiList.do](https://www.bizinfo.go.kr/apiList.do) 접속 (상단 메뉴: 활용정보 → 정책정보 개방)
2. 목록에서 **"지원사업정보 API"** 클릭
3. 상세 페이지 맨 아래 **"신청하기"** 버튼 클릭
4. 기관명·신청자명·이메일·전화번호·시스템명·시스템 IP(또는 URL) 입력 후 제출
5. **그 자리에서 인증키가 즉시 발급**되고 입력한 이메일로도 전송됩니다

확인된 API 스펙(`scripts/fetch-and-tag.mjs`에 이미 반영):
- `GET https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do`
- 필수: `crtfcKey` / 선택: `dataType`(json/rss), `searchCnt`, `searchLclasId`(분야 01~09), `hashtags`, `pageUnit`, `pageIndex`
- JSON 응답의 정확한 필드명(공고명/기관명/URL 등)이 우리가 짐작한 것과 다르면
  `fetchRawAnnouncements()`와 `pickField()`에 넘기는 후보 필드명 목록을 조정하세요.

(선택) [K-Startup Open API](https://www.k-startup.go.kr)도 같은 방식으로 별도 신청해 데이터 소스를 늘릴 수 있습니다.
단, 마찬가지로 GitHub Actions에서 막힐 가능성이 있으니 로컬에서 먼저 테스트해보세요.

## 태깅 방식: 키워드 규칙 기반 (LLM 미사용)

공고 원문(제목/사업개요/지원대상/해시태그)에서 특정 키워드를 찾아 우리 스키마(업종/지역/기업구분/인증/대표자특성 등)로 자동 변환합니다.
예: "청년창업" → 청년대표, "제조업" → 업종 mfg, "업력 5년 이내" → maxYears: 5.
규칙은 `scripts/fetch-and-tag.mjs`의 `CATEGORY_RULES`, `FOUNDER_TYPE_RULES` 등의 배열에 있으며, 키워드를 추가/수정하면 바로 반영됩니다.

**정확도가 완벽하지 않을 수 있습니다** — 키워드가 없으면 놓치고, 문맥 이해 없이 단순 매칭이라 오탐도 있을 수 있습니다.
그래서 모든 자동 수집 항목은 `reviewed: false`로 표시되어 사이트에 "자동수집 · 검수대기" 배지가 붙습니다.
위 "데이터 갱신하는 방법" 4단계에서 눈으로 한 번 훑어보고 push하는 것을 권장합니다.

## NTIS 국가R&D 과제 이력 ("R&D 이력" 탭)

`scripts/fetch-ntis.mjs`는 `scripts/fetch-and-tag.mjs`와 별도로 동작하는 스크립트입니다. NTIS(국가과학기술
지식정보서비스)의 "국가R&D 과제검색 서비스(전체용)" API는 **"지금 신청 가능한 공고"가 아니라 이미 승인·
수행된 국가R&D 과제의 메타정보(수행기관/예산/연구기간 등)** 를 검색하는 서비스라서, `data/policies.json`
(공고 목록 + 신청자격 매칭)과는 데이터 성격이 완전히 달라 별도 파일(`data/rnd-history.json`)과 별도 탭
("R&D 이력")으로 분리했습니다. 용도는 "우리 업종·키워드에서 어떤 정부 R&D 프로그램이 반복적으로 운영되어
왔는지" 참고하는 것이며, 실제 지금 공모 중인지는 소관 부처·전문기관 공고를 별도로 확인해야 합니다.

- 인증키: NTIS 마이페이지 → 활용신청 현황 → 국가R&D 과제검색 서비스(전체용) 상세의 "키정보"
- **IP 화이트리스트 방식**이라, 신청 시 등록한 서버 IP와 실제 요청 IP가 정확히 일치해야 합니다. 사설 IP
  (예: `192.168.x.x`)를 등록하면 막힙니다 — 반드시 공인(외부) IP를 등록하세요. 가정/사무실 회선은 보통
  유동 IP라 나중에 다시 막힐 수 있고, 그때는 NTIS에 IP 변경을 요청해야 합니다(자체 수정 메뉴가 없어
  1:1 문의로 처리).
- `scripts/.env.local`에 `NTIS_APPRV_KEY`, `NTIS_KEYWORDS`(쉼표로 구분한 검색어) 설정 후
  `node scripts/fetch-ntis.mjs` 실행 → `data/rnd-history.json` 갱신
- GitHub Actions(`fetch-policies.yml`)에도 같은 단계가 있지만, IP 화이트리스트 특성상 해외 클라우드
  러너에서는 막힐 가능성이 높아 `continue-on-error`로 처리해뒀습니다 — 사실상 로컬 PC에서 수동 실행이
  주력 경로입니다(`run-fetch.bat` 더블클릭 시 같이 실행됩니다).

## 앞으로 더 고려할 것

- 규칙에 없는 키워드가 많이 보이면 `CATEGORY_RULES` 등에 키워드 추가
- 중복 공고 감지 정교화 (현재는 이름+기관 기준으로 자동 수집분만 매번 새로 만듦)
- 마감된 공고 자동 제거
- 완전 자동화가 꼭 필요해지면: 한국 리전 서버(자체 PC를 self-hosted runner로 등록하거나, 국내 클라우드 소형 인스턴스)에서 스케줄 실행하는 방식으로 전환 가능
