import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "policies.json");

// scripts/.env.local (git에 올라가지 않는 파일)에 필요한 키들을 한 번만
// 저장해두면, 이후로는 run-fetch.bat 더블클릭만으로 실행할 수 있습니다.
// 어떤 키를 넣어야 하는지는 scripts/.env.local.example 참고.
function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadLocalEnv();

// ---------------------------------------------------------------------------
// 여러 공공 API 소스를 동시에 수집하는 구조.
//
// 소스를 추가하려면 SOURCES 배열에 { key, label, envKey, fetchRaw, mapRaw } 하나만
// 추가하면 됩니다. envKey에 해당하는 환경변수(scripts/.env.local)가 없는 소스는
// 자동으로 건너뛰므로, 키를 하나씩 발급받는 대로 점진적으로 채워 넣을 수 있습니다.
//
// mapRaw(raw)는 소스마다 다른 응답 필드명을 공통 형태
//   { title, desc, target, tags, period, agency, url }
// 로 통일해주는 역할만 합니다. 실제 필드명은 각 API를 실제 키로 한 번 호출해
// 응답을 콘솔에 찍어본 뒤(예: console.log(JSON.stringify(data,null,2))) 아래
// TODO 표시된 부분을 확인해서 채워 넣으세요.
//
// 참고: 중소벤처24의 "이노비즈확인서/벤처기업확인서/메인비즈확인서"는 공고
// 목록이 아니라 "특정 사업자등록번호 하나의 인증 여부를 조회"하는 단건 조회
// API라서 이 수집 파이프라인(공고 목록 수집)에는 맞지 않습니다. 이 API들은
// 나중에 "사업자등록번호 입력 → 보유 인증 체크박스 자동 확인" 같은 별도 기능을
// 만들 때 쓰는 것이 맞고, 지금은 연결하지 않았습니다.
// ---------------------------------------------------------------------------

// 정부 공공API가 가끔 응답을 아예 안 주고 멈추는 경우가 있어서(실제로 겪음: 타임아웃 없이
// 기다리다 17분 넘게 걸린 뒤 강제 종료됨), 요청마다 타임아웃을 걸어 무한정 멈추지 않게 합니다.
async function fetchJson(url, timeoutMs = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const bodyText = await res.text();
  if (!res.ok) {
    // data.go.kr류 API는 400/401 응답 본문(XML/JSON)에 정확한 실패 사유가 들어있는 경우가
    // 많아서(예: 필수 파라미터 누락, 서비스키 미승인 등) 본문 앞부분을 그대로 보여줍니다.
    throw new Error(`HTTP ${res.status} (${String(url).split("?")[0]}) - ${bodyText.slice(0, 300)}`);
  }
  return JSON.parse(bodyText);
}

async function fetchText(url, timeoutMs = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${String(url).split("?")[0]}) - ${bodyText.slice(0, 300)}`);
  }
  return bodyText;
}

// 페이지네이션처럼 같은 요청을 수십~수백 번 반복할 때, 그중 한두 개가 일시적으로
// 타임아웃/오류가 나도 전체를 포기하지 않도록 몇 번 재시도합니다.
async function postJson(url, body, timeoutMs = 20000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${String(url).split("?")[0]}) - ${bodyText.slice(0, 300)}`);
  }
  return JSON.parse(bodyText);
}

async function fetchJsonWithRetry(url, attempts = 2, timeoutMs) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url, timeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// K-Startup Open API는 JSON을 요청해도 항상 <item><col name="필드명">값</col>...</item>
// 형태의 XML을 돌려줘서, 별도 XML 라이브러리 없이 이 특정 구조만 정규식으로 파싱합니다.
function parseColXml(xmlText) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch;
  while ((itemMatch = itemRe.exec(xmlText))) {
    const obj = {};
    const colRe = /<col name="([^"]+)">([\s\S]*?)<\/col>/g;
    let colMatch;
    while ((colMatch = colRe.exec(itemMatch[1]))) {
      obj[colMatch[1]] = stripHtml(colMatch[2]);
    }
    items.push(obj);
  }
  return items;
}

function ymdToIso(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return "";
  return yyyymmdd.slice(0, 4) + "-" + yyyymmdd.slice(4, 6) + "-" + yyyymmdd.slice(6, 8);
}

// data.go.kr류 API가 발급하는 서비스키는 이미 URL 인코딩된 상태("인코딩" 키, %2B/%3D%3D 등을
// 포함)입니다. URLSearchParams.set()으로 넣으면 그걸 또 한 번 인코딩해버려서(이중 인코딩)
// 서버가 키를 못 알아보고 "등록되지 않은 서비스키" 오류가 납니다. 그래서 serviceKey는
// URLSearchParams를 거치지 않고 이미 인코딩된 값 그대로 쿼리스트링에 직접 붙입니다.
function withServiceKey(endpoint, encodedServiceKey, extraParams) {
  const url = new URL(endpoint);
  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  }
  const sep = url.search ? "&" : "?";
  return url.toString() + sep + "serviceKey=" + encodedServiceKey;
}

// 중소벤처24(portal.smes.go.kr/ione-gw)는 data.go.kr과 인증 방식이 다릅니다:
// 파라미터명이 "serviceKey"가 아니라 "token"이고, 키 값 자체가 미리 인코딩되어
// 있지도 않으므로(2026-08-21 실측: URLSearchParams로 정상 인코딩해야 통과함,
// withServiceKey처럼 인코딩을 건너뛰면 오히려 실패) 일반적인 방식으로 붙입니다.
function withToken(endpoint, token, extraParams) {
  const url = new URL(endpoint);
  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  }
  url.searchParams.set("token", token);
  return url.toString();
}

function ymdCompact(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

const SOURCES = [
  {
    key: "bizinfo",
    label: "기업마당",
    envKey: "BIZINFO_API_KEY",
    async fetchRaw() {
      // 2026-08-19 수정: searchCnt=100만 요청하고 페이지네이션이 없어서 첫 100건만
      // 수집되던 문제 발견("중소기업 AI 활용 도입 및 AI 훈련 지원", "AX 원스톱 바우처",
      // "AI 통합 바우처(AI바우처)" 등 실제 기업마당에 있는 공고가 데이터에 아예 없었음 -
      // 2026-08-19 사용자 리포트). pageUnit/pageIndex로 페이지를 넘기며 끝까지 수집합니다.
      const pageUnit = 100;
      const maxPages = 30; // 안전장치: 3000건 넘게 반복되는 이상 상황 방지
      const all = [];
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const url = new URL("https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do");
        url.searchParams.set("crtfcKey", process.env.BIZINFO_API_KEY);
        url.searchParams.set("dataType", "json");
        url.searchParams.set("searchCnt", String(pageUnit));
        url.searchParams.set("pageUnit", String(pageUnit));
        url.searchParams.set("pageIndex", String(pageIndex));
        const data = await fetchJson(url);
        // TODO: 실제 응답 스키마와 다르면 아래 배열 경로를 조정하세요.
        const items = data.jsonArray || data.items || [];
        all.push(...items);
        console.log(`[기업마당] ${pageIndex}페이지 ${items.length}건 수집 (누적 ${all.length}건)`);
        if (items.length < pageUnit) break; // 마지막 페이지(요청한 개수보다 적게 옴)
      }
      return all;
    },
    mapRaw(raw) {
      return {
        title: pickField(raw, ["pblancNm", "title", "bsnsTitl"]),
        desc: pickField(raw, ["bsnsSumryCn", "content", "cn", "description"]),
        target: pickField(raw, ["trgetNm", "target", "reqstTrgetNm"]),
        tags: pickField(raw, ["hashtags", "hashTag"]),
        period: pickField(raw, ["reqstBeginEndDe", "period", "aplyPd"]),
        agency: pickField(raw, ["jrsdInsttNm", "agency", "instNm"]) || "확인 필요",
        url: pickField(raw, ["pblancUrl", "url", "pageUrl"]) || "https://www.bizinfo.go.kr",
      };
    },
  },
  {
    key: "sme24-announce",
    label: "중소벤처24 공고정보",
    envKey: "SME24_ANNOUNCE_API_KEY",
    async fetchRaw() {
      // 중소벤처24는 API(공고정보/행사정보 등)마다 서비스키가 따로 발급되므로
      // SME24_API_KEY 하나를 공유하지 않고 API별 키를 씁니다.
      const endpoint = process.env.SME24_ANNOUNCE_ENDPOINT;
      if (!endpoint) {
        console.log("[중소벤처24 공고정보] SME24_ANNOUNCE_ENDPOINT가 없어 건너뜁니다. .env.local.example 참고.");
        return [];
      }
      // 2026-08-21 실측: strDt/endDt는 공고의 신청기간이 아니라 등록/갱신일 기준
      // 필터로 보입니다(이 범위 이전의 pblancBgnDt를 가진 항목도 섞여 나옴). 이
      // API는 pageNo/numOfRows 같은 페이지네이션 파라미터가 없고 범위 내 전체를
      // 한 번에 돌려주므로(1년치 약 20MB), 아직 신청기간이 안 끝났을 수 있는
      // 공고를 놓치지 않도록 최근 1년을 통째로 가져온 뒤, 실제 마감 여부는
      // index.html의 status 로직이 화면에서 걸러줍니다.
      const end = new Date();
      const start = new Date(end);
      start.setFullYear(start.getFullYear() - 1);
      const url = withToken(endpoint, process.env.SME24_ANNOUNCE_API_KEY, {
        strDt: ymdCompact(start),
        endDt: ymdCompact(end),
        html: "no",
      });
      // 2026-08-21 실측: 이 요청(1년치, ~24MB)은 게이트웨이가 가끔 타임아웃/500을 내는
      // 불안정한 응답을 보입니다(같은 요청을 반복하면 대부분 8~9초 안에 정상 응답). 그래서
      // 다른 소스처럼 재시도를 붙였습니다.
      const data = await fetchJsonWithRetry(url, 3, 45000);
      if (data?.result?.resultCd !== "0") {
        throw new Error(`resultCd=${data?.result?.resultCd} ${data?.result?.resultMsg || ""}`);
      }
      const items = data.result.data || [];
      // 2026-08-21 사용자 리포트로 발견: 이 API에는 "중소기업 재직 근로자"가 청약 자격으로
      // 신청하는 아파트 특별공급/우선공급 안내문이 다수(2026-08-21 기준 252건) 섞여 있습니다.
      // 이건 회사가 신청하는 지원사업이 아니라 개인 근로자 대상 주택 공급이라 이 사이트의
      // 매칭 대상이 아닙니다. 게다가 모든 이런 공고가 "수도권(서울특별시, 경기도, 인천광역시)
      // 거주자" 같은 신청자 거주지 요건 문구를 공통으로 담고 있어서, 회사 소재지 기준 지역
      // 필터(REGION_RULES)가 그 문구를 공고 자체의 지역으로 잘못 인식해 실제로는 특정 지역
      // 아파트인데도 여러 지역에 걸쳐 노출되는 부작용까지 있었습니다(예: 경기도 아파트인데
      // 서울로 필터링해도 노출됨). 카테고리+지역 필터를 고치는 대신, 애초에 매칭 대상이
      // 아닌 이 유형 자체를 걸러내는 게 근본적인 해결책이라 여기서 제외합니다.
      // 처음에는 "장기근속자"라는 단어로만 걸렀는데("장긱근속자"처럼 원문 오타가 있는 공고,
      // "국민임대 우선공급대상자", "중소기업 근로자 주택우선공급"처럼 그 단어 자체가 없는
      // 변형까지는 못 잡아서(2026-08-21, 실데이터 9309건 중 3건 발견) "주택/임대"와
      // "특별공급/우선공급"이 제목에 같이 있으면 제외하는 조건으로 넓혔었는데, 그마저도
      // "확인서 발급 - OO 통합공공임대주택"처럼 "특별공급/우선공급" 없이 "확인서"로만 표현되는
      // 변형이 더 있어서(2026-08-21, 6건 발견) 결국 부동산·주택 공급 관련 표현을 폭넓게 모은
      // 하나의 목록으로 정리했습니다. 사용자가 "부동산 관련 정보는 다 안 보이게 해달라"고
      // 명시적으로 요청한 부분이기도 합니다. 이 목록에 걸리면 무조건 제외합니다(다른 소스에는
      // 이런 부동산 콘텐츠가 없는 것을 확인함 - 이 API에서만 나타나는 유형).
      const REAL_ESTATE_RE = /특별공급|우선공급|입주자모집|청약|행복주택|국민임대|장기전세주택|임대주택|공공주택|부동산/;
      const before = items.length;
      const filtered = items.filter((item) => !REAL_ESTATE_RE.test(pickField(item, ["pblancNm"])));
      if (filtered.length !== before) {
        console.log(`[중소벤처24 공고정보] 부동산·개인주택공급 관련 안내 ${before - filtered.length}건 제외.`);
      }
      return filtered;
    },
    mapRaw(raw) {
      // 2026-08-21 실제 응답으로 확인된 필드명(중소벤처24 공고정보 API 명세 참고).
      // areaNm/bizType/sportType/cmpScale/induty는 이미 구조화된 값이라, 자유
      // 텍스트가 아니라 tags에 그대로 실어 보내면 기존 키워드 규칙(CATEGORY_RULES 등)이
      // title/desc/target과 동일하게 스캔해서 인식합니다.
      const tagsParts = [raw.induty, raw.areaNm, raw.bizType, raw.sportType, raw.cmpScale].filter(Boolean);
      return {
        title: pickField(raw, ["pblancNm"]),
        desc: pickField(raw, ["policyCnts"]),
        target: pickField(raw, ["sportTrget"]),
        tags: tagsParts.join(","),
        period: raw.pblancBgnDt && raw.pblancEndDt ? `${raw.pblancBgnDt} ~ ${raw.pblancEndDt}` : "",
        agency: pickField(raw, ["sportInsttNm"]) || "중소벤처24",
        url: pickField(raw, ["pblancDtlUrl", "reqstLinkInfo"]) || "https://www.smes.go.kr",
      };
    },
  },
  {
    key: "sme24-event",
    label: "중소벤처24 행사정보",
    envKey: "SME24_EVENT_API_KEY",
    async fetchRaw() {
      const endpoint = process.env.SME24_EVENT_ENDPOINT;
      if (!endpoint) {
        console.log("[중소벤처24 행사정보] SME24_EVENT_ENDPOINT가 없어 건너뜁니다. .env.local.example 참고.");
        return [];
      }
      // 공고정보와 달리 이 API는 POST + JSON 바디이고, 인증은 token 쿼리스트링으로
      // 전달합니다(2026-08-21 실측: 헤더 방식도 되지만 쿼리스트링이 더 단순해서 이걸 씀).
      // searchCnt/mdfcnYmd 없이 호출해도 자동으로 최근 것만(실측 시점 기준 최근 약 3개월,
      // 318건, 350KB) 돌아와서 별도 날짜 범위 지정이 필요 없습니다 - 공고정보(20MB, 1년치를
      // 직접 계산해서 요청)와는 다른 특성이니 나중에 건수가 갑자기 늘어나면 재확인하세요.
      const url = withToken(endpoint, process.env.SME24_EVENT_API_KEY);
      const data = await postJson(url, {}, 30000);
      const result = data?.result?.result;
      if (!result || result.RESULT?.RES_CD !== "0") {
        throw new Error(`RES_CD=${result?.RESULT?.RES_CD} ${result?.RESULT?.RES_MSG || ""}`);
      }
      return result.RECORD || [];
    },
    mapRaw(raw) {
      // 2026-08-21 실제 응답으로 확인된 필드명. evntPrdCn(행사기간)은 "yyyyMMdd ~ yyyyMMdd"
      // 형식이라 파싱해서 다른 소스와 같은 "yyyy-MM-dd ~ yyyy-MM-dd" 형식으로 맞춥니다.
      // rcptPrdCn(접수기간)은 "~2026-07-15"나 "과목별 상이"처럼 형식이 제각각이라 그대로 못
      // 쓰고, 파싱 가능한 evntPrdCn을 기본으로 쓰되 없으면 원문을 그대로 보여줍니다.
      const m = String(raw.evntPrdCn || "").match(/^(\d{8})\s*~\s*(\d{8})$/);
      const period = m ? `${ymdToIso(m[1])} ~ ${ymdToIso(m[2])}` : raw.rcptPrdCn || raw.evntPrdCn || "";
      const tagsParts = [
        raw.evntInfoFldNm,
        raw.evntInfoTypeNm,
        raw.evntInfoRgnNm,
        ...(Array.isArray(raw.hstgCn) ? raw.hstgCn : []),
      ].filter(Boolean);
      return {
        title: pickField(raw, ["evntInfoTtlNm"]),
        desc: pickField(raw, ["evntOtlnCn"]),
        target: "",
        tags: tagsParts.join(","),
        period,
        agency: pickField(raw, ["evntInfoFlfmtInstNm"]) || "중소벤처24",
        url: pickField(raw, ["srcUrlAddr"]) || "https://www.smes.go.kr",
      };
    },
  },
  {
    key: "kstartup",
    label: "K-Startup",
    envKey: "KSTARTUP_API_KEY",
    async fetchRaw() {
      const endpoint = process.env.KSTARTUP_ENDPOINT;
      if (!endpoint) {
        console.log("[K-Startup] KSTARTUP_ENDPOINT가 없어 건너뜁니다. .env.local.example 참고.");
        return [];
      }
      // 이 API는 JSON을 요청해도 <item><col name="...">값</col></item> 형태의 XML을 돌려줍니다.
      const url = withServiceKey(endpoint, process.env.KSTARTUP_API_KEY, { numOfRows: "100", pageNo: "1" });
      const xmlText = await fetchText(url);
      return parseColXml(xmlText);
    },
    mapRaw(raw) {
      const start = ymdToIso(raw.pbanc_rcpt_bgng_dt);
      const end = ymdToIso(raw.pbanc_rcpt_end_dt);
      return {
        title: pickField(raw, ["intg_pbanc_biz_nm", "biz_pbanc_nm"]),
        desc: pickField(raw, ["pbanc_ctnt", "aply_trgt_ctnt"]),
        target: pickField(raw, ["aply_trgt", "aply_trgt_ctnt"]),
        tags: "",
        period: start && end ? `${start} ~ ${end}` : "",
        agency: pickField(raw, ["pbanc_ntrp_nm"]) || "K-Startup",
        url: pickField(raw, ["biz_aply_url", "detl_pg_url", "biz_gdnc_url"]) || "https://www.k-startup.go.kr",
      };
    },
  },
  {
    key: "mpb",
    label: "기획재정부",
    envKey: "MPB_API_KEY",
    async fetchRaw() {
      const endpoint = process.env.MPB_ENDPOINT;
      if (!endpoint) {
        console.log("[기획재정부] MPB_ENDPOINT가 없어 건너뜁니다. .env.local.example 참고.");
        return [];
      }
      // 이 API는 국고보조사업 내역사업을 통째로 돌려주는데(연간 20만 건 이상), 대부분은
      // 실제 "신청 접수기간"이 아니라 예산 회계연도 전체 기간(1/1~12/31)만 있습니다.
      // 표본 확인 결과 실제 접수기간(RCEPT_BEGIN_DE/RCEPT_END_DE)이 있는 건 전체의 약 2%뿐이라,
      // 그 2%만 남기고 나머지는 버립니다 - 그래야 사이트가 20만 건짜리 파일을 매번 안 불러옵니다.
      //
      // 그것만으로는 부족합니다: 이 데이터는 "산업/기업 지원"뿐 아니라 문화활동·안전·교육·
      // 환경·복지·보건의료 등 정부 예산 전체를 다 담고 있어서(예: 무용/음악/연극 지원사업,
      // 학생 승마체험 등이 그대로 섞여 나옴 - 2026-08-14 실사용 중 발견), CMMN_ATRB_NM
      // (정부 표준 기능별 분류)이 "13.1차 산업지원/14.산업·에너지지원/16.교통물류진흥/
      // 17.방송통신진흥/18.과학기술진흥"인 것만 남기고, 그중에서도 "고등학생/아동/청소년" 같은
      // 개인·학생 대상 태그가 붙은 건(예: 같은 "13.1차 산업지원" 예산으로 집행되는 학생 승마체험
      // 프로그램)은 회사가 신청하는 사업이 아니므로 제외합니다.
      const BUSINESS_ATRB_CODES = ["13", "14", "16", "17", "18"];
      const INDIVIDUAL_TAG_RE = /학생|아동|청소년|유아|노인|어린이|대학생/;
      function isBusinessRelevant(item) {
        let atrbs;
        try {
          atrbs = JSON.parse(pickField(item, ["CMMN_ATRB_NM"]) || "[]");
        } catch (e) {
          return false;
        }
        const hasBusinessCategory = atrbs.some((v) => {
          const m = String(v).match(/^(\d+)\./);
          return m && BUSINESS_ATRB_CODES.includes(m[1]);
        });
        const hasIndividualTag = atrbs.some((v) => INDIVIDUAL_TAG_RE.test(String(v)));
        return hasBusinessCategory && !hasIndividualTag;
      }

      // 이 데이터에는 "기업이 신청하는 지원사업"이 아니라 부처가 자체 예산으로 집행하는 항목
      // (실태조사·연구용역, 부처 직영 시설 운영비, 행사·기념일 개최비, 정책 포럼·통상 협력 활동
      // 등)도 카테고리 필터를 통과한 채 섞여 있습니다(2026-08-18 실사용 중 발견: "외주제작 거래
      // 실태조사", "재난방송 종합상황실 운영", "2026년도 한국임업진흥원 지원(경상보조)" 등).
      // 문구 기반 추정이라 완벽하지 않고(드물게 진짜 지원사업을 걸러낼 수 있음), 그래도 회사가
      // 신청할 수 없는 항목이 목록에 뒤섞이는 것보다는 낫다고 판단해 제외합니다.
      // (주)/㈜/(유) 같은 법인 표기가 제목에 있는 항목은 실사용 데이터 확인 결과(2026-08-18) 전부
      // "이미 특정 업체가 선정·집행된 예산 내역"(예: "유피로지스(주) 남양주센터 ... 도입사업",
      // "(주)엠비씨넷_발효인간")이었습니다 — 다른 회사가 신청할 수 있는 공모가 아닙니다.
      // 2026-08-18 추가 발견: "OOO발전소 기본지원사업(공공사회복지)(민간보조)"류는 발전소
      // 주변지역 주민·지자체 대상 상생지원금(전원개발촉진법에 따른 발전소주변지역 지원사업)이라
      // 회사가 신청하는 사업이 아닙니다. 발전소 하나당 여러 세부항목(공공사회복지/소득증대 등)이
      // 나오는데 전국 발전소 수만큼 반복되어 목록을 심하게 오염시킵니다.
      // 2026-08-19 추가: "발전소"라는 단어가 제목에 없이 특정 발전소 고유명("에스엠솔라포천태양광")
      // 으로만 쓰인 사업이 이름만 봐서는 안 걸러지던 문제 - 지원내용/지원대상까지 합쳐서 검사합니다.
      const POWER_PLANT_SUBSIDY_RE = /발전소.*기본지원사업|기본지원사업.*발전소/;
      // "OO감시단"(민간 감시인력 모집)도 회사 지원사업이 아니라 개인 위촉 성격입니다.
      const CITIZEN_MONITOR_RE = /감시단|모니터링단/;
      // 2026-08-18 추가: "영광군 건강증진형 스마트경로당 구축사업" 등 경로당(공공 복지시설)
      // 구축·리모델링 사업, "한-베트남·몽골 유통물류 정책협력사업" 등 정부간 정책협력 활동.
      // 2026-08-19 추가(2차): "재외국민"(해외 거주 한국인 창업준비생 대상, 국내 기존 기업과
      // 무관), "전문가 간담회"(연구용역성 회의 운영, 회사가 신청하는 사업이 아님). "간담회"만
      // 단독으로는 "프랜차이즈 로드쇼 참가기업 모집" 같은 진짜 지원사업도 걸려서(부대행사로
      // 간담회를 포함) "전문가 간담회"로 좁혔습니다.
      const NON_APPLICABLE_RE =
        /실태조사|종합상황실|학술활동|학술대회|정책\s*포럼|포럼$|경제협력\s*네트워크|산업통상\s*협력|시장조사|가입\s*지원$|비즈니스\s*파트너십|경제통상\s*정책|지방정부\s*협력|경상보조|위탁운영|\(주\)|㈜|\(유\)|경로당|정책협력|심층조사|피해구제|분쟁조정|팩트체크|특별기획|기업간거래공정화|재외국민|전문가\s*간담회/;
      // "OO 개최"로 끝나면서 "지원"이라는 말이 아예 없는 항목(예: "과학의날 개최")은 정부가 직접
      // 여는 행사 예산이지 회사가 신청하는 지원사업이 아닙니다. "OO박람회 참가 지원" 같은 진짜
      // 지원사업까지 걸러내지 않도록 "지원"이 포함된 경우는 제외 대상에서 뺍니다.
      function isGovernmentHostedEvent(name) {
        return /개최$/.test(name) && !name.includes("지원");
      }
      // 특정 지역 방송사가 이미 제작을 위탁받은 콘텐츠 항목(예: "MBC경남_뉴스파다", "제주문화방송_...",
      // "전주MBC_5일장 3분레시피")도 다른 회사가 신청할 수 있는 공모가 아니라 이미 정해진 수행사에게
      // 준 제작비입니다. "_" 앞부분에 방송사명이 있는 경우만 좁게 잡아서, "동반성장문화조성_..."처럼
      // 그냥 항목 구분에 "_"를 쓴 일반 지원사업까지 걸러내지 않도록 합니다.
      // 2026-08-19 추가(전수 재검토): "KBC광주방송_육씨내고향", "티비씨_싱싱고향별곡",
      // "주식회사 엠비씨강원영동_AI로 되살린 강원의 시간", "CBS_로컬 도파민", "경인방송_훈맹정음",
      // "JTV_전북의 발견"처럼 콜사인이 한글 표기이거나 목록에 없던 지역 방송사가 걸러지지
      // 않던 문제(총 2360건 재검토 중 발견).
      const BROADCASTER_COMMISSION_RE = /^.{0,15}(MBC|KBS|SBS|KNN|방송공사|문화방송|KBC|티비씨|광주방송|엠비씨|CBS|경인방송|JTV)/;
      // 2026-08-19 추가: "지원대상" 필드가 이미 "이 사업은 회사가 신청하는 게 아니다"를 말해주는
      // 경우가 있는데 지금까지 안 쓰고 있었습니다("전 국민"/"대한민국 전국민" = 공공 서비스·시스템
      // 운영, "한국 청년 인재"/"대학생,일반인" = 개인 대상 프로그램, "OO군민"/"OO시민" = 특정
      // 지역 주민 대상). 발견 계기: "한국청년 일본취업지원"(한국 청년 인재), "스마트빌리지 보급
      // 및 확산 사업"(진안군민) 등이 회사 지원사업 목록에 섞여 나온 문제(2026-08-19 사용자 리포트).
      // "해당없음"/"해당사항 없음"은 시험해보니 방송콘텐츠·연구용역(비적용) 뿐 아니라 "물류AI기술
      // 도입 지원사업", "우리 기업의 해외시장 진출 지원"처럼 실제로는 회사 대상인데 원본 API가
      // 지원대상 필드를 그냥 비워둔 경우도 많이 걸려서(오탐 다수) 이 패턴은 채택하지 않았습니다 -
      // 애매한 "해당없음" 하나만으로 제외하기보다는 위양성(진짜 지원사업을 놓치는 것)을 피하는
      // 쪽을 택했습니다. 이런 예산성 항목은 NON_APPLICABLE_RE의 구체적인 주제 키워드로 개별
      // 대응합니다(예: "심층조사", "팩트체크", "특별기획").
      // 2026-08-19 추가(2차): "수산물상생할인지원"의 지원대상이 "일반국민"(전 국민과 같은
      // 뜻이지만 "전"이 없어서 안 걸리던 표현)이라 놓쳤던 문제.
      const NON_BUSINESS_TARGET_RE = /전\s*국민|일반\s*국민/;
      // 2026-08-19 추가(2차): "상인회"(전통시장 상인 "조합·단체" 앞으로 신청하는 사업으로,
      // 개별 회사가 신청하는 게 아님 - "전통시장 주차환경개선"에서 발견).
      const INDIVIDUAL_TARGET_RE = /대학생|일반인|청년\s*인재|청년\s*구직자|취업\s*준비생|(시민|군민|구민)$|상인회/;
      // 2026-08-19 추가(1차 적용 후 발견): "청소년,대학생,일반인,대학,연구기관,일반기업,1인
      // 창조기업"처럼 여러 대상을 나열한 목록형 지원대상은 "대학생"/"일반인"이 함께 있어도
      // "일반기업"/"1인 창조기업"도 같이 있으면 회사도 신청 가능하다는 뜻이라 제외하면 안 됩니다
      // (강북창업지원센터, 도봉구 중소기업창업보육센터 등을 잘못 제거했던 문제). 지원대상에
      // 기업 신호(기업/법인/소상공인/중소기업/벤처/사업자)가 하나라도 있으면 제외하지 않습니다.
      const BUSINESS_TARGET_RE = /기업|법인|소상공인|중소기업|벤처|사업자/;
      function hasNonBusinessTarget(item) {
        const target = (pickField(item, ["SPORT_CND_CN", "SPORT_CN_DC"]) || "").trim();
        if (!target) return false;
        if (BUSINESS_TARGET_RE.test(target)) return false;
        return NON_BUSINESS_TARGET_RE.test(target) || INDIVIDUAL_TARGET_RE.test(target);
      }
      function isApplicableProgram(item) {
        const name = pickField(item, ["DDTLBZ_NM", "DTLBZ_NM"]);
        const desc = pickField(item, ["DDTLBZ_BSNS_PURPS_DC", "DTLBZ_BSNS_PURPS_DC"]) || "";
        const target = pickField(item, ["SPORT_CND_CN", "SPORT_CN_DC"]) || "";
        const checkText = [name, desc, target].filter(Boolean).join(" ");
        if (NON_APPLICABLE_RE.test(checkText)) return false;
        if (isGovernmentHostedEvent(name)) return false;
        if (POWER_PLANT_SUBSIDY_RE.test(checkText)) return false;
        if (CITIZEN_MONITOR_RE.test(checkText)) return false;
        if (name.includes("_") && BROADCASTER_COMMISSION_RE.test(name)) return false;
        if (hasNonBusinessTarget(item)) return false;
        return true;
      }

      const bsnsyear = String(new Date().getFullYear());
      const numOfRows = 1000;
      const passesFilter = (item) =>
        item.RCEPT_BEGIN_DE && item.RCEPT_END_DE && isBusinessRelevant(item) && isApplicableProgram(item);

      const firstUrl = withServiceKey(endpoint, process.env.MPB_API_KEY, {
        pageNo: "1", numOfRows: String(numOfRows), resultType: "json", bsnsyear,
      });
      const first = await fetchJsonWithRetry(firstUrl);
      const header = first.response?.header;
      if (!header || header.resultCode !== "00") {
        throw new Error((header && header.resultMsg) || "알 수 없는 응답 형식");
      }
      const totalCount = first.response?.body?.totalCount || 0;
      const totalPages = Math.ceil(totalCount / numOfRows);
      const items = (first.response?.body?.items?.item || []).filter(passesFilter);
      let failedPages = 0;

      for (let page = 2; page <= totalPages; page++) {
        const url = withServiceKey(endpoint, process.env.MPB_API_KEY, {
          pageNo: String(page), numOfRows: String(numOfRows), resultType: "json", bsnsyear,
        });
        try {
          const data = await fetchJsonWithRetry(url);
          const pageItems = data.response?.body?.items?.item || [];
          items.push(...pageItems.filter(passesFilter));
        } catch (err) {
          // 20만 건을 200번 가까이 나눠 받다 보면 한두 페이지 정도는 일시적으로 실패할 수
          // 있습니다. 그렇다고 지금까지 모은 걸 전부 버리지 않고, 그 페이지만 건너뜁니다.
          failedPages++;
          console.error(`[기획재정부] ${page}/${totalPages}페이지 수집 실패, 건너뜁니다: ${err.message}`);
        }
      }

      // 이 데이터는 같은 사업이 수행기관/지역별로 쪼개진 세부 항목이 통째로 들어있어서
      // "제목+소관명"이 같은 항목이 수백 번씩 반복됩니다. 사용자에게는 사실상 같은 사업으로
      // 보이므로 대표 1건만 남기고 합칩니다. (normalizeForDedup는 이제 모듈 최상단의
      // 공용 함수 - 소스 간 전역 중복 제거에서도 같이 씁니다.)
      // 2026-08-18 시도했다가 되돌림: 정부 예산코드(DTLBZ_ID)를 중복 제거 키로 써봤으나,
      // 이 코드는 실제로는 "세부사업"보다 더 상위(단위사업 등) 수준의 공통 코드라 서로 다른
      // 여러 사업(예: "소상공인협업아카데미"의 수도권/영남권/중부권판, "도약(Jump-Up)"의
      // 25년/26년 회차, "적외선 숙성장치" 시범 vs 보급)까지 하나로 합쳐버리는 심각한 오탐이
      // 확인되어 텍스트 기반 비교로 되돌립니다. "해외조달시장 진출 맞춤형지원사업"처럼 오탈자
      // 섞인 표기 차이는 텍스트 유사도로도 안전하게 못 잡는다는 것까지 확인했고(진짜 다른
      // 두 사업의 유사도가 오탈자 쌍보다 더 높게 나옴), 지금은 해결 방법이 없어 남겨둡니다.
      const seen = new Map();
      for (const item of items) {
        const key =
          normalizeForDedup(pickField(item, ["DDTLBZ_NM", "DTLBZ_NM"])) +
          "||" +
          normalizeForDedup(pickField(item, ["JRSD_NM"]));
        if (!seen.has(key)) seen.set(key, item);
      }
      const deduped = [...seen.values()];

      console.log(
        `[기획재정부] 전체 ${totalCount}건(${totalPages}페이지, 실패 ${failedPages}페이지) 중 ` +
        `접수기간이 있고 기업 지원 성격의 카테고리인 ${items.length}건, ` +
        `제목+기관 중복 제거 후 ${deduped.length}건만 사용합니다.`
      );
      return deduped;
    },
    mapRaw(raw) {
      const start = ymdToIso(pickField(raw, ["RCEPT_BEGIN_DE"]));
      const end = ymdToIso(pickField(raw, ["RCEPT_END_DE"]));
      return {
        title: pickField(raw, ["DDTLBZ_NM", "DTLBZ_NM"]),
        desc: pickField(raw, ["DDTLBZ_BSNS_PURPS_DC", "DTLBZ_BSNS_PURPS_DC"]),
        target: pickField(raw, ["SPORT_CND_CN", "SPORT_CN_DC"]),
        tags: "",
        period: start && end ? `${start} ~ ${end}` : "",
        agency: pickField(raw, ["JRSD_NM"]) || "기획재정부",
        url: pickField(raw, ["BSNS_POPUP_URL", "BSNS_GUIDANCE_URL"]) || "https://www.moef.go.kr",
      };
    },
  },
];

// ---------------------------------------------------------------------------
// 규칙(키워드) 기반 태깅
//
// LLM 없이, 공고 원문에 특정 키워드가 있는지로 우리 매칭 스키마의 조건을 채웁니다.
// 정확도는 LLM 태깅보다 낮을 수 있으니, 모든 자동 수집 항목은 reviewed:false로
// 표시되어 사람이 검수하기 전까지 사이트에 "자동수집 · 검수대기" 배지가 붙습니다.
// ---------------------------------------------------------------------------

function stripHtml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    // 일부 공공 API는 개행문자(&#xD;/&#xA;)나 괄호(&#40;/&#41;)를 숫자 문자 참조로 보내는데,
    // 서버 쪽에서 &amp;를 한 번 더 씌운 이중 이스케이프도 종종 있어 &amp; 치환 다음에 처리합니다.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function pickField(raw, candidateFields) {
  for (const key of candidateFields) {
    if (raw[key]) return stripHtml(String(raw[key]));
  }
  return "";
}

// 같은 사업이 표기만 다르게(대소문자·공백·괄호·연도 표기 차이) 여러 번 나오는 걸
// 하나로 합치기 위한 정규화. 원래 기획재정부(MPB) 소스 내부 중복 제거용으로 만들었다가
// (2026-08-18, "2026년 도약(Jump-Up) 프로그램"이 표기 차이로 5건 넘게 남던 문제),
// 2026-08-21 소스 간 중복(기업마당 vs 중소벤처24 공고정보 등, 같은 공고가 여러 API에
// 동시에 올라오는 경우)까지 걸러내도록 전역 유틸로 옮겼습니다.
function normalizeForDedup(text) {
  // 제목 맨 앞의 연도 표기("2026년" vs "2026년도" vs "2026")만 표기 차이로 보고 통일합니다.
  // 문장 중간의 "OO년 선발기업" 같은 회차 표기는 건드리지 않습니다 - 이건 실제로 다른
  // 회차(예: 25년/26년 선발기업)를 가리킬 수 있어서 지워버리면 서로 다른 예산 항목이
  // 하나로 합쳐지는 부작용이 생깁니다.
  // "년도"는 두 글자가 붙어있을 때만 하나로 취급해야 합니다 - "\s*도?"처럼 느슨하게 쓰면
  // "2026년 도약" 같은 제목에서 "도약"의 "도"를 "년도"의 "도"로 착각해 "2026 약"으로
  // 잘못 잘라먹는 문제가 있었습니다(2026-08-18 발견).
  const withNormalizedYear = text.trim().replace(/^(\d{4})\s*(?:년도|년)\s*/, "$1 ");
  return withNormalizedYear.toLowerCase().replace(/[\s()（）\-_.]/g, "");
}

function buildTextBlob(normalized) {
  return [normalized.title, normalized.desc, normalized.target, normalized.tags].join(" \n ");
}

// 2026-08-19 추가(전수 재검토 중 발견): 기업마당 hashtags 필드는 검색 노출용으로 "서울,부산,
// 대구,인천,광주,대전,울산,세종,강원,충북,충남,전북,전남,경북,경남,제주"처럼 관련 없는 지역명
// 17개를 통째로 나열하거나, "콘텐츠제작"처럼 교육과정 커리큘럼 키워드를 나열하는 경우가 많아서
// 이 필드를 업종/지역 등 "자격 요건(하드 필터)" 판정에 그대로 쓰면 안 됩니다. 실측 결과 hashtags
// 포함 여부에 따라 지역 판정이 46%(706/1532건), 업종 판정이 7.6%(117/1532건) 달라졌고, 대부분
// "강원 영동권 관광 지원사업"이 전국 대상으로 잘못 넓어지는 식의 오탐이었습니다. 그래서 자격
// 요건(업종/지역/구군/기업규모/업력/수출실적 등 필수조건)은 hashtags를 뺀 제목+본문+지원대상
// 텍스트로만 판정하고, hashtags를 포함한 전체 텍스트는 분야 분류(카테고리)·보유인증·대표자특성처럼
// "맞으면 가점, 틀려도 제외 안 함"인 경우에만 씁니다.
function buildFilterTextBlob(normalized) {
  return [normalized.title, normalized.desc, normalized.target].join(" \n ");
}

function includesAny(text, keywords) {
  return keywords.some((kw) => text.includes(kw));
}

const CATEGORY_RULES = [
  { category: "ai", keywords: ["인공지능", "AI ", "AI바우처", "AI솔루션"] },
  { category: "rnd", keywords: ["R&D", "기술개발", "연구개발", "기술혁신"] },
  { category: "smart", keywords: ["스마트공장", "디지털전환", "자동화 설비", "제조데이터"] },
  { category: "esg", keywords: ["ESG", "탄소중립", "온실가스", "환경경영"] },
  { category: "export", keywords: ["수출", "해외진출", "해외마케팅", "바이어"] },
  { category: "hr", keywords: ["고용", "채용", "인건비", "일자리", "내일채움공제"] },
  { category: "facility", keywords: ["설비", "장비 구입", "시설 투자", "노후설비"] },
  { category: "market", keywords: ["판로", "마케팅", "홍보", "전시회", "박람회"] },
  { category: "consulting", keywords: ["컨설팅", "멘토링", "자문", "진단"] },
  { category: "fund", keywords: ["융자", "정책자금", "보조금", "사업화자금", "육성자금"] },
];

const FOUNDER_TYPE_RULES = [
  { code: "youth", keywords: ["청년창업", "청년 대표", "청년기업", "만 39세"] },
  { code: "woman", keywords: ["여성기업", "여성 대표", "여성창업"] },
  { code: "disabled", keywords: ["장애인기업", "장애인 대표"] },
  { code: "senior", keywords: ["시니어창업", "중장년창업", "만 50세"] },
];

const CERT_RULES = [
  { code: "venture", keywords: ["벤처기업"] },
  { code: "innobiz", keywords: ["이노비즈"] },
  { code: "mainbiz", keywords: ["메인비즈"] },
  { code: "social", keywords: ["사회적기업"] },
  { code: "root", keywords: ["뿌리기업", "뿌리산업"] },
  { code: "familyFriendly", keywords: ["가족친화"] },
];

const SIZE_RULES = [
  { code: "pre", keywords: ["예비창업자", "예비 창업"] },
  // 2026-08-18 추가: "소공인"은 소상공인 중에서도 제조업 등 상시근로자 10인 미만 사업체를
  // 가리키는 법정 하위 구분인데, 별도 코드가 없어서 소상공인과 같은 "sole"로 묶었습니다.
  // 그래야 "소공인스마트제조지원" 같은 사업이 sizes:["sole","sme"] 기본값으로 빠지지 않고
  // 중소기업 필터에서 정상적으로 제외됩니다.
  { code: "sole", keywords: ["소상공인", "소공인"] },
  { code: "sme", keywords: ["중소기업"] },
  { code: "mid", keywords: ["중견기업"] },
];

// 2026-08-19 추가: "희망리턴패키지"처럼 기획재정부(mpb) 원본 텍스트가 너무 짧아서
// ("희망리턴패키지 지원 등") SIZE_RULES 키워드가 전혀 안 걸리는 잘 알려진 사업들은
// 기본값 ["sole","sme"]로 빠지는 대신 실제 대상으로 직접 지정합니다(희망리턴패키지는
// 폐업·재기 소상공인 전용 사업으로, 중소기업은 대상이 아님 - 2026-08-19 사용자 리포트).
const KNOWN_PROGRAM_SIZE_HINTS = {
  "희망리턴패키지": ["sole"],
};

// 2026-08-19 추가: 지원대상 안내에 "semas.or.kr"(소상공인시장진흥공단 - 소상공인·전통시장
// 전용 기관)가 있으면, 원문이 짧아 "소상공인"이라는 단어 자체가 없어도 소상공인 전용 사업입니다
// ("시장상권인프라조성", "클린제조환경조성", "판로개척지원", "지역상권육성" 등 - 전부 SEMAS를
// 통해서만 신청하는데 짧은 원문엔 "소상공인"이라는 단어가 없어 중소기업까지 잘못 포함되던 문제).
function isSemasOnlyTarget(target) {
  return Boolean(target) && target.includes("semas.or.kr");
}

const INDUSTRY_RULES = [
  // "제조업"이라는 정확한 단어 없이 "제조DX", "스마트공장", "제조혁신 전문가" 같은 표현만
  // 쓰는 공고가 많아서(예: "제조DX멘토단 활용지원" 15건 중 14건이 industries:"all"로 잘못
  // 넓어졌던 문제, 2026-08-14 발견) 제조업 특화임이 명백한 표현들을 추가했습니다.
  // 2026-08-18 추가: "로봇산업기술개발사업" 등 로봇 특화 R&D가 제조업 키워드 없이 나오던 문제.
  // 2026-08-19 추가: "화학안전 사업장 조성 지원사업"(유해화학물질 취급시설), "한-베 섬유의류
  // 테크비즈 고도화"(섬유업), "조선기자재및중소형선박해외시장개척지원"(조선업), "균형잡힌
  // 스트림 경쟁력 확보"(원사-제조-염색-봉제 등 섬유 공급망)처럼 업종명 없이 세부 공정·소재
  // 용어만 쓰는 제조업 특화 사업이 걸러지지 않던 문제(2026-08-19 사용자 리포트: 도소매업으로
  // 검색해도 이런 제조업 전용 사업이 그대로 나옴).
  // 주의: "원사"는 넣지 마세요 - "지원사업"이라는 흔한 단어의 부분 문자열이라
  // 거의 모든 공고가 섬유업으로 오탐됩니다(2026-08-19 발견: 963건 중 115건이 걸림).
  // 2026-08-19 추가: "GP Switzerland AI 부품 산업자동화 파트너십"처럼 "산업자동화"라는
  // 표현만 쓰고 "자동화 설비"라는 정확한 문구는 없는 사업.
  { code: "mfg", keywords: ["제조업", "스마트공장", "제조혁신", "제조DX", "제조데이터", "자동화 설비", "산업자동화", "로봇", "유해화학물질", "화학물질관리", "섬유", "조선", "선박기자재", "봉제", "염색가공"] },
  // 2026-08-18 추가: "5G 기반 통신망 서비스" 등 통신 인프라 특화 사업.
  // 2026-08-19 추가: "비면허 주파수 활용 유망기술 실증" 등 주파수 특화 사업.
  // 주의: "전파"는 넣지 마세요 - "질병 전파" 등 일반적인 "퍼진다"는 뜻으로도 흔히 쓰여
  // 통신/전파 산업과 무관한 사업(예: 축산 방역)까지 오탐됩니다.
  { code: "it", keywords: ["정보통신", "소프트웨어", "IT", "5G", "통신망", "주파수"] },
  // 2026-08-18 추가: "AI 응용제품 신속 상용화(보건분야, 만성질환관리)" 등 "보건" 표현만 쓰는
  // 사업이 걸러지지 않던 문제. 2026-08-19 추가: "의료기기 사업화 촉진"처럼 "의료기기"만 쓰고
  // "바이오/헬스케어" 표현은 없는 사업.
  { code: "bio", keywords: ["바이오", "헬스케어", "제약", "보건", "의료기기"] },
  // 2026-08-18 추가: 방송·미디어·OTT 관련 사업이 "콘텐츠" 키워드가 본문에 없어서
  // industries:"all"로 잘못 넓어지던 문제(예: "지역 방송 제작역량 강화", "OTT산업 경쟁력 강화",
  // "AI 더빙 특화 K-FAST 확산") - 방송/미디어 특화 표현들을 추가했습니다.
  // 2026-08-21 수정: 중소벤처24 데이터(문장이 훨씬 김)에서 "콘텐츠"/"영상"/"미디어"/"방송"을
  // 맨 단어로 쓰면 "DDP 쇼룸에서 콘텐츠를 체험하는 공간"(패션기업 대상 사업), "홍보영상 제작"
  // (사업 안내 문구일 뿐), "SNS/미디어 홍보"(마케팅 지원 문구) 처럼 실제 업종과 무관한 문맥에서도
  // 걸려서 industries가 잘못 좁아지는 문제가 다수 발견됨(2026-08-21 사용자 리포트). "이 회사가
  // 콘텐츠/미디어 업종이다"를 실제로 의미하는 복합어로만 좁혔습니다.
  { code: "content", keywords: ["콘텐츠산업", "콘텐츠기업", "콘텐츠 제작", "콘텐츠코리아랩", "게임", "웹툰", "방송 제작", "방송산업", "OTT", "더빙", "영상 제작", "영상콘텐츠", "미디어산업", "뉴미디어"] },
  // 2026-08-18 추가: "국)식문화개선지원" 등 "식문화" 표현만 쓰는 농식품 관련 사업.
  // 2026-08-21 제거: "식문화"는 "여수시 음식점 경사로 설치 지원사업"처럼 일반 음식점·서비스업
  // 사업의 "지역 식문화 발전" 같은 배경 설명에도 흔히 등장해서 농업과 무관한 사업까지
  // agri로 잘못 태깅하는 사례가 발견됨(2026-08-21).
  { code: "agri", keywords: ["농식품", "농업", "축산", "수산", "임업", "산림", "목재"] },
  // 2026-08-18 추가: "플랜트-EPC" 등 플랜트·엔지니어링 특화 사업이 걸러지지 않던 문제.
  // 2026-08-18 추가: "한옥전문인력양성" 등 한옥·전통건축 특화 사업, "디지털도로 AI 신기술
  // 지원사업" 등 도로·교통 인프라 특화 사업(국토교통부).
  // 2026-08-21 수정: 맨 "도로"는 "한국도로공사"(전혀 무관한 여러 지원사업의 시행기관명)에도
  // 걸려서 오탐이 컸음(2026-08-21 사용자 리포트 - "희망나눔 자립지원 프로그램" 등 도로/건설과
  // 무관한 사업이 다수 construction으로 잘못 태깅됨). "디지털도로"(원래 추가 사유였던 표현)와
  // "도로 건설"만 남기고 맨 "도로"는 뺐습니다.
  // 2026-08-21 추가 제거: 맨 "건설업"도 뺐습니다 - 중소벤처24의 일반 소상공인 임대료·융자
  // 지원사업 다수가 "지원제외 업종: 건설업ㆍ부동산업ㆍ금융보험업 등"처럼 "건설업"을 오히려
  // 제외 업종으로 나열하는 경우가 흔한데, 단순 키워드 포함 여부만 보는 이 로직은 "포함"과
  // "제외" 문맥을 구분하지 못해 건설업과 무관한 사업까지 잘못 태깅했습니다(2026-08-21 발견).
  // 정말 건설업 특화 사업은 "플랜트"/"한옥"/"도로 건설" 등 더 구체적인 표현으로도 대부분
  // 잡힙니다.
  { code: "construction", keywords: ["플랜트", "한옥", "디지털도로", "도로 건설", "도로포장", "교통인프라"] },
  // 2026-08-18 추가: "시장상권인프라조성(시장경영지원)" 등 전통시장 상인 대상 사업,
  // "프랜차이즈 로드쇼 참가기업 모집" 등 프랜차이즈 특화 사업.
  // 주의: "유통업"은 넣지 마세요 - "적외선 숙성장치 활용 소고기 숙성육 생산기술 시범"처럼
  // 축산농가/육류가공 유통업체를 가리키는 축산업 특화 사업까지 도소매업으로 오탐됩니다
  // (2026-08-19 발견). "도소매업"이라는 정확한 단어와 전통시장/프랜차이즈 특화 표현만 씁니다.
  { code: "retail", keywords: ["도소매업", "전통시장", "시장경영", "프랜차이즈"] },
  // 2026-08-18 추가: "스포츠산업 선도기업 육성", "관광교통" 등 실제로는 특정 업종(스포츠산업/
  // 관광업) 대상인 문화체육관광부 사업이 industries:"all"로 잘못 넓어지던 문제.
  { code: "service", keywords: ["서비스업", "스포츠산업", "스포츠기업", "관광"] },
  // 2026-08-14 추가: 기후에너지환경부류 사업(온실가스/분산에너지/녹색산업 등)이 기존 8개
  // 업종 어디에도 안 맞아 계속 industries:"all"로 빠지던 문제 - "에너지·환경" 업종을 새로 만듦.
  // 2026-08-18 추가: "수소기업", "재자원화 시설" 등도 같은 부류라 키워드 보강.
  // 2026-08-21 제거: 맨 "환경"은 "친환경 소비재"(마케팅 형용사일 뿐), "업무환경/환경개선"
  // (시설·근로환경 개선처럼 전혀 무관한 맥락)에도 흔히 등장해서 오탐이 컸음(2026-08-21
  // 사용자 리포트 - "미용업 시설개선 지원사업" 등 에너지·환경 산업과 무관한 사업이 다수
  // energy로 잘못 태깅됨). 나머지 구체적인 표현들이 이미 진짜 에너지·환경 사업을 충분히
  // 잡아내므로, 맨 "환경" 없이도 커버리지 손실은 적을 것으로 판단.
  { code: "energy", keywords: ["에너지", "온실가스", "탄소중립", "신재생", "미세먼지", "자원순환", "녹색산업", "수소", "재자원화", "물기업", "태양광", "풍력"] },
];

// 기획재정부(mpb) 데이터는 문장이 짧아서(예: "과수무병묘목(보급종)생산공급지원") INDUSTRY_RULES
// 키워드가 본문에 안 나타나는 경우가 많음. 그런 경우 "all"로 잘못 넓혀지는 대신, 소관 부처명
// 자체가 업종을 사실상 확정하는 경우(농림축산식품부→농림수산업 등)엔 그걸로 보정합니다.
const AGENCY_INDUSTRY_HINTS = {
  "농림축산식품부": ["agri"],
  "해양수산부": ["agri"],
  "농촌진흥청": ["agri"],
  "산림청": ["agri"],
};

const REGION_RULES = [
  { code: "seoul", keywords: ["서울"] },
  { code: "busan", keywords: ["부산"] },
  { code: "daegu", keywords: ["대구"] },
  { code: "incheon", keywords: ["인천"] },
  { code: "gwangju", keywords: ["광주"] },
  { code: "daejeon", keywords: ["대전"] },
  { code: "ulsan", keywords: ["울산"] },
  { code: "sejong", keywords: ["세종"] },
  // 2026-08-19 추가: "서울ㆍ경기ㆍ인천ㆍ강원"처럼 가운뎃점(ㆍ)으로 지역을 나열한 제목에서
  // "경기"가 "경기도"도 "경기 "(뒤에 공백)도 아니라서 빠지던 문제. "경기" 자체는 "경기"(景氣,
  // 경제상황)라는 뜻으로도 흔히 쓰여서("경기 침체", "경기 부양") 단독으로는 못 넣고,
  // 가운뎃점과 붙어 있을 때만(목록 표기 관례) 지역으로 인정합니다.
  { code: "gyeonggi", keywords: ["경기도", "경기 ", "경기ㆍ", "ㆍ경기", "경기·", "·경기"] },
  { code: "gangwon", keywords: ["강원"] },
  { code: "chungbuk", keywords: ["충청북도", "충북"] },
  { code: "chungnam", keywords: ["충청남도", "충남"] },
  { code: "jeonbuk", keywords: ["전라북도", "전북"] },
  { code: "jeonnam", keywords: ["전라남도", "전남"] },
  { code: "gyeongbuk", keywords: ["경상북도", "경북"] },
  { code: "gyeongnam", keywords: ["경상남도", "경남"] },
  { code: "jeju", keywords: ["제주"] },
  // 2026-08-18 추가: 개별 시/도명이 아니라 "수도권/중부권/호남권" 같은 광역 권역 단위로만
  // 표기하는 사업들(예: "소상공인협업아카데미(중부권)")이 REGION_RULES에 안 걸려서 지역무관
  // (all)으로 잘못 넓어지던 문제 - 권역별로 소속 시/도 코드 전체를 매핑합니다. 권역 구분은
  // 기관마다 조금씩 달라서(예: "중부권"에 강원을 포함하는지 여부) 완벽히 정확하지는 않습니다.
  { code: ["seoul", "incheon", "gyeonggi"], keywords: ["수도권"] },
  { code: ["daejeon", "sejong", "chungnam", "chungbuk", "gangwon"], keywords: ["중부권"] },
  { code: ["daejeon", "sejong", "chungnam", "chungbuk"], keywords: ["충청권"] },
  { code: ["gwangju", "jeonbuk", "jeonnam"], keywords: ["호남권"] },
  { code: ["busan", "daegu", "ulsan", "gyeongbuk", "gyeongnam"], keywords: ["영남권"] },
  { code: ["busan", "ulsan", "gyeongnam"], keywords: ["동남권"] },
  { code: ["daegu", "gyeongbuk"], keywords: ["대경권"] },
];

// 2026-08-18 추가: "용산구 이태원", "도봉구 중소기업창업보육센터", "영광군 건강증진형..." 처럼
// 시/도보다 좁은 시/군/구 단위로만 신청 가능한 사업이 많아서, 시/도만으로는 "서울에 있으면
// 다 해당"으로 보이지만 실제로는 특정 구/군에 소재한 회사만 신청 가능한 경우를 구분합니다.
// "중구", "동구", "서구", "남구", "북구", "강서구", "고성군"처럼 여러 시/도에 같은 이름의
// 구/군이 있어서(예: 중구는 서울·부산·대구·인천·대전·울산에 다 있음), 아래 매칭은 반드시
// 해당 시/도명이 같은 텍스트에 함께 있을 때만 인정합니다(matchDistrict 함수 참고).
const DISTRICT_RULES = {
  seoul: ["종로구","중구","용산구","성동구","광진구","동대문구","중랑구","성북구","강북구","도봉구","노원구","은평구","서대문구","마포구","양천구","강서구","구로구","금천구","영등포구","동작구","관악구","서초구","강남구","송파구","강동구"],
  busan: ["중구","서구","동구","영도구","부산진구","동래구","남구","북구","해운대구","사하구","금정구","강서구","연제구","수영구","사상구","기장군"],
  daegu: ["중구","동구","서구","남구","북구","수성구","달서구","달성군","군위군"],
  incheon: ["중구","동구","미추홀구","연수구","남동구","부평구","계양구","서구","강화군","옹진군"],
  gwangju: ["동구","서구","남구","북구","광산구"],
  daejeon: ["동구","중구","서구","유성구","대덕구"],
  ulsan: ["중구","남구","동구","북구","울주군"],
  gyeonggi: ["수원시","성남시","의정부시","안양시","부천시","광명시","평택시","동두천시","안산시","고양시","과천시","구리시","남양주시","오산시","시흥시","군포시","의왕시","하남시","용인시","파주시","이천시","안성시","김포시","화성시","광주시","양주시","포천시","여주시","연천군","가평군","양평군"],
  gangwon: ["춘천시","원주시","강릉시","동해시","태백시","속초시","삼척시","홍천군","횡성군","영월군","평창군","정선군","철원군","화천군","양구군","인제군","고성군","양양군"],
  chungbuk: ["청주시","충주시","제천시","보은군","옥천군","영동군","증평군","진천군","괴산군","음성군","단양군"],
  chungnam: ["천안시","공주시","보령시","아산시","서산시","논산시","계룡시","당진시","금산군","부여군","서천군","청양군","홍성군","예산군","태안군"],
  jeonbuk: ["전주시","군산시","익산시","정읍시","남원시","김제시","완주군","진안군","무주군","장수군","임실군","순창군","고창군","부안군"],
  jeonnam: ["목포시","여수시","순천시","나주시","광양시","담양군","곡성군","구례군","고흥군","보성군","화순군","장흥군","강진군","해남군","영암군","무안군","함평군","영광군","장성군","완도군","진도군","신안군"],
  gyeongbuk: ["포항시","경주시","김천시","안동시","구미시","영주시","영천시","상주시","문경시","경산시","의성군","청송군","영양군","영덕군","청도군","고령군","성주군","칠곡군","예천군","봉화군","울진군","울릉군"],
  gyeongnam: ["창원시","진주시","통영시","사천시","김해시","밀양시","거제시","양산시","의령군","함안군","창녕군","고성군","남해군","하동군","산청군","함양군","거창군","합천군"],
  jeju: ["제주시","서귀포시"],
};

// 텍스트에서 시/도 자체는 이미 REGION_RULES로 찾은 뒤(matchedRegions), 그 시/도 소속 구/군
// 이름이 "같은 텍스트에" 정확히 하나만 나오면 그 구/군으로 좁힙니다. 여러 구/군이 동시에
// 나오거나 해당 시/도가 지역 목록에 없으면(예: region이 "all"이면) 좁히지 않습니다 - 안전한
// 쪽으로만 판단합니다.
function matchDistrict(text, matchedRegions) {
  if (matchedRegions === "all") return null;
  let found = null;
  for (const province of matchedRegions) {
    const list = DISTRICT_RULES[province];
    if (!list) continue;
    for (const district of list) {
      if (text.includes(district)) {
        if (found && found.district !== district) return null; // 구/군이 2개 이상 나오면 특정 안 함
        found = { province, district };
      }
    }
  }
  return found;
}

// 2026-08-19 추가: "충청북도"가 발주한 "충북청주강소연구개발특구..." 공고의 본문이 "전국 16개
// 강소특구 네트워크"처럼 여러 시/도 이름을 배경 설명으로 언급하고 있어서, 본문 전체를 훑는
// REGION_RULES만으로는 regions가 경기를 제외한 16개 시/도 전부로 잘못 넓어지는 문제가
// 있었습니다(2026-08-19 사용자 리포트: 서울 회사인데 지역이 전혀 안 맞는 충북 사업이 뜸).
// 반대로 "도봉구청"이 발주한 "도봉구 중소기업창업보육센터"는 본문에 "서울"이라는 시/도명 자체가
// 없어서 regions가 아예 "all"로 빠지는 문제도 있었습니다. 두 경우 모두 "발주기관명 자체가 이미
// 관할 지역을 확정"하므로, 본문 스캔보다 발주기관명을 우선합니다.
const PROVINCE_AGENCY_NAMES = {
  "서울특별시": "seoul", "부산광역시": "busan", "대구광역시": "daegu", "인천광역시": "incheon",
  "광주광역시": "gwangju", "대전광역시": "daejeon", "울산광역시": "ulsan", "세종특별자치시": "sejong",
  "경기도": "gyeonggi", "강원특별자치도": "gangwon", "강원도": "gangwon",
  "충청북도": "chungbuk", "충청남도": "chungnam",
  "전북특별자치도": "jeonbuk", "전라북도": "jeonbuk", "전라남도": "jeonnam",
  "경상북도": "gyeongbuk", "경상남도": "gyeongnam", "제주특별자치도": "jeju",
};

function inferRegionFromAgency(agency) {
  if (!agency) return null;
  if (PROVINCE_AGENCY_NAMES[agency]) {
    return { regions: [PROVINCE_AGENCY_NAMES[agency]], district: null };
  }
  const m = agency.match(/^(.+?(?:구|시|군))청$/);
  if (!m) return null;
  const localName = m[1];
  for (const [province, districts] of Object.entries(DISTRICT_RULES)) {
    if (districts.includes(localName)) {
      return { regions: [province], district: { province, district: localName } };
    }
  }
  return null;
}

function matchCategory(text) {
  for (const rule of CATEGORY_RULES) {
    if (includesAny(text, rule.keywords)) return rule.category;
  }
  return "etc";
}

function matchMany(text, rules) {
  const hits = rules.filter((r) => includesAny(text, r.keywords)).map((r) => r.code);
  return hits.length ? hits : null;
}

function matchAllOr(text, rules) {
  // rule.code는 보통 문자열 하나지만, REGION_RULES의 광역 권역 규칙("수도권" 등)처럼 여러 지역
  // 코드를 한 번에 매핑해야 하는 경우 배열일 수 있어서 평탄화합니다.
  const hits = [];
  for (const rule of rules) {
    if (!includesAny(text, rule.keywords)) continue;
    if (Array.isArray(rule.code)) hits.push(...rule.code);
    else hits.push(rule.code);
  }
  const unique = [...new Set(hits)];
  return unique.length ? unique : "all";
}

// "창업기업"은 중소기업창업 지원법상 기본적으로 "창업 후 7년 이내인 기업"을 뜻합니다.
// 공고 원문에 구체적인 연차(예: "업력 3년 이내")가 없어도 "창업기업/창업자"라는 표현만
// 있으면 실질적으로 오래된 기업은 제외 대상이므로, 못 찾으면 7년을 기본값으로 둡니다.
// 2026-08-19 추가: "지역혁신창업활성화 지원"(지역 신규 창업 인프라 조성/입주기업 모집)처럼
// "창업기업"이라는 정확한 단어 없이 "창업 인프라 조성"/"창업보육센터 입주" 표현만 쓰는 사업도
// 신규·초기 창업기업 전용인 경우가 많습니다.
const STARTUP_ONLY_KEYWORDS = ["창업기업", "창업 기업", "창업자 ", "초기창업", "창업초기", "창업벤처", "창업 인프라 조성", "창업보육센터 입주"];

function matchMaxYears(text) {
  const explicit = text.match(/(?:업력|창업|설립)\s*(?:후|일로부터)?\s*(\d{1,2})\s*년\s*(?:미만|이내)/);
  if (explicit) return Number(explicit[1]);
  if (includesAny(text, STARTUP_ONLY_KEYWORDS)) return 7;
  return null;
}

function tagAndBuildPolicy(normalized, source) {
  const text = buildTextBlob(normalized);
  const filterText = buildFilterTextBlob(normalized);
  const category = matchCategory(text);
  // "중소기업특별지원지역"은 위기지역 지정 명칭일 뿐인데 "중소기업"이라는 글자가 우연히 들어있어서
  // 소상공인 전용 사업까지 sizes:["sole","sme"]로 잘못 넓히는 문제가 있었습니다(2026-08-18 발견:
  // "(서울강원 한지회) 2026년 재기사업화 지원" - 실제로는 "경영위기 소상공인" 전용인데 지원대상
  // 문구에 있는 "중소기업특별지원지역"(위기지역 유형명) 때문에 중소기업도 대상인 것처럼 보임).
  // 기업 규모(sizes) 판정에서만 이 문구를 제거하고 판단합니다.
  const sizeText = filterText.replace(/중소기업특별지원지역/g, "");
  let sizes = matchMany(sizeText, SIZE_RULES) || ["sole", "sme"]; // 명시 안 되면 가장 흔한 대상으로 넓게 잡음
  if (KNOWN_PROGRAM_SIZE_HINTS[normalized.title]) {
    sizes = KNOWN_PROGRAM_SIZE_HINTS[normalized.title];
  } else if (isSemasOnlyTarget(normalized.target)) {
    sizes = ["sole"];
  }
  const founderTypes = matchMany(text, FOUNDER_TYPE_RULES);
  const certs = matchMany(text, CERT_RULES);
  let industries = matchAllOr(filterText, INDUSTRY_RULES);
  if (industries === "all" && AGENCY_INDUSTRY_HINTS[normalized.agency]) {
    industries = AGENCY_INDUSTRY_HINTS[normalized.agency];
  }
  let regions = matchAllOr(filterText, REGION_RULES);
  const agencyRegion = inferRegionFromAgency(normalized.agency);
  if (agencyRegion) {
    regions = agencyRegion.regions;
  }
  const district = agencyRegion && agencyRegion.district ? agencyRegion.district : matchDistrict(filterText, regions);
  // 2026-08-21 사용자 리포트로 발견: "영농부산물"(→"부산"), "세대구성원"(→"대구") 같은 단어 내부
  // 우연한 지역명 포함, "[전남광주]"/"광주시(경기도)" 처럼 한 표기가 여러 지역코드에 걸리는 경우,
  // "수도권" 같은 광역 언급 등으로 REGION_RULES 스캔 결과(regions)가 실제보다 넓게 잡히는 사례가
  // 다수 확인됨(예: "경기 광주시" 공고가 지역명 "광주" 충돌로 gwangju도 함께 들어가 서울로 필터링해도
  // 노출됨). district(특정 구/군/시로 한정된 공고에만 채워짐)가 확정되면 그 공고는 정의상 해당
  // 시/도 하나에만 해당하는 것이므로, regions를 그 시/도 하나로 좁힙니다 — 개별 충돌 케이스를
  // 하나씩 패치하는 대신 구조적으로 한 번에 해결하는 방식입니다.
  if (district) {
    regions = [district.province];
  }
  const maxYears = matchMaxYears(filterText);
  const exportRequired = includesAny(filterText, ["수출실적 보유", "수출 실적이 있는"]);
  const rndRequired = includesAny(filterText, ["부설연구소 보유", "연구전담부서 보유"]);
  const insuranceRequired = includesAny(filterText, ["고용보험 가입 사업장"]);
  const taxClean = !["consulting", "etc"].includes(category);

  const name = normalized.title || "이름 미확인 공고";
  const summarySource = normalized.desc || name;
  const summary = summarySource.slice(0, 90) + (summarySource.length > 90 ? "…" : "");

  const benefits = [];
  if (normalized.desc) benefits.push({ label: "지원내용", value: normalized.desc.slice(0, 200) + (normalized.desc.length > 200 ? "…(원문 확인 필요)" : "") });
  if (normalized.target) benefits.push({ label: "지원대상", value: normalized.target.slice(0, 150) });
  if (normalized.period) benefits.push({ label: "신청기간", value: normalized.period });
  if (!benefits.length) benefits.push({ label: "안내", value: "공고 원문에서 자동 추출된 상세 내용이 없습니다. 공식 사이트에서 확인하세요." });

  return {
    id: makeId(name, normalized.agency),
    name,
    agency: normalized.agency,
    url: normalized.url,
    category,
    summary,
    benefits,
    elig: {
      sizes,
      industries,
      regions,
      district,
      maxYears,
      founderTypes,
      certs,
      exportRequired,
      rndRequired,
      insuranceRequired,
      taxClean,
    },
    source: "auto",
    sourceApi: source.key,
    reviewed: false,
  };
}

function makeId(name, agency) {
  // base64로 인코딩한 원문을 그냥 앞에서 16자만 자르면 같은 접두어로 시작하는 제목들이
  // (예: "[전남광주] ...") 전부 같은 id로 충돌합니다. 해시값을 자르는 것과는 다릅니다 -
  // 해시는 균등 분포라 앞부분만 잘라도 안전하지만, 원문 인코딩은 앞부분에 정보가 쏠려있어
  // 그렇지 않습니다. 그래서 원문 대신 해시값을 자릅니다.
  return "auto-" + crypto.createHash("sha256").update(`${name}|${agency}`).digest("base64url").slice(0, 16);
}

async function collectFromSource(source) {
  if (!process.env[source.envKey]) {
    console.log(`[${source.label}] ${source.envKey}가 없어 건너뜁니다.`);
    return [];
  }
  let rawList;
  try {
    rawList = await source.fetchRaw();
  } catch (err) {
    console.error(`[${source.label}] 수집 실패, 이 소스는 건너뜁니다:`, err.message);
    return [];
  }
  console.log(`[${source.label}] ${rawList.length}건의 공고를 가져왔습니다.`);

  const policies = [];
  for (const raw of rawList) {
    try {
      policies.push(tagAndBuildPolicy(source.mapRaw(raw), source));
    } catch (err) {
      console.error(`[${source.label}] 태깅 실패, 이 공고는 건너뜁니다:`, err.message);
    }
  }
  return policies;
}

async function main() {
  const rawAutoPolicies = [];
  for (const source of SOURCES) {
    rawAutoPolicies.push(...(await collectFromSource(source)));
  }

  // 2026-08-21 추가: 소스가 늘어나면서(중소벤처24 공고정보 등) 같은 공고가 여러 API에
  // 동시에 올라와 중복 등록되는 사례가 확인됨(예: 중소벤처24 공고정보 응답 중 상세URL이
  // bizinfo.go.kr을 가리키는 항목 존재 - 기업마당 공고를 그대로 재노출). 기존에는 기획재정부
  // (MPB) 소스 "내부" 중복만 제거했고 소스 "간" 중복은 전혀 걸러지지 않았습니다. SOURCES
  // 배열 순서(기업마당이 맨 앞)를 그대로 우선순위로 써서, "제목+기관"이 같으면 먼저 나온
  // 소스의 항목만 남깁니다.
  const seenAcrossSources = new Map();
  for (const policy of rawAutoPolicies) {
    const key = normalizeForDedup(policy.name) + "||" + normalizeForDedup(policy.agency);
    if (!seenAcrossSources.has(key)) seenAcrossSources.set(key, policy);
  }
  const autoPolicies = [...seenAcrossSources.values()];
  console.log(
    `소스 간 중복 제거: 전체 ${rawAutoPolicies.length}건 중 ` +
    `제목+기관 중복 ${rawAutoPolicies.length - autoPolicies.length}건 제거 → ${autoPolicies.length}건 사용.`
  );

  // 2026-08-19 추가: API 장애/키 만료 등으로 이번 실행에서 가져온 공고가 기존 데이터보다
  // 크게 줄어들면(절반 미만), 원인 파악 전까지는 파일을 덮어쓰지 않고 기존 데이터를 그대로
  // 둡니다. 이 안전장치가 없어서 2026-08-19 새벽 자동 실행 때 모든 소스가 0건을 반환했는데도
  // 그대로 덮어써서 963건이던 policies.json이 통째로 비어버린 사고가 있었습니다.
  let previousCount = 0;
  try {
    const prev = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    previousCount = Array.isArray(prev.policies) ? prev.policies.length : 0;
  } catch (err) {
    previousCount = 0;
  }
  if (previousCount > 0 && autoPolicies.length < previousCount * 0.5) {
    console.error(
      `수집된 공고(${autoPolicies.length}건)가 기존 데이터(${previousCount}건)보다 크게 줄어들어, ` +
      `안전을 위해 data/policies.json을 덮어쓰지 않고 종료합니다. API 키/네트워크 상태를 확인한 뒤 다시 실행하세요.`
    );
    process.exit(1);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    note: "기업마당 Open API 자동 수집 + 키워드 규칙 기반 자동 태깅 결과. 모든 항목은 사람이 검수(reviewed:true로 변경)하기 전까지 화면에 자동수집 · 검수대기 표시가 붙습니다. 규칙 기반 태깅은 LLM보다 정확도가 낮을 수 있으니 반드시 검수 후 반영하세요.",
    policies: autoPolicies,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`data/policies.json 갱신 완료: 총 ${autoPolicies.length}건 자동 수집`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


