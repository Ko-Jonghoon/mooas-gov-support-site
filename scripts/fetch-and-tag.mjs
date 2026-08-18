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
async function fetchJsonWithRetry(url, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url);
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

const SOURCES = [
  {
    key: "bizinfo",
    label: "기업마당",
    envKey: "BIZINFO_API_KEY",
    async fetchRaw() {
      const url = new URL("https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do");
      url.searchParams.set("crtfcKey", process.env.BIZINFO_API_KEY);
      url.searchParams.set("dataType", "json");
      url.searchParams.set("searchCnt", "100");
      const data = await fetchJson(url);
      // TODO: 실제 응답 스키마와 다르면 아래 배열 경로를 조정하세요.
      return data.jsonArray || data.items || [];
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
      const url = withServiceKey(endpoint, process.env.SME24_ANNOUNCE_API_KEY);
      const data = await fetchJson(url);
      // TODO: 실제 응답의 배열 경로로 조정하세요(예: data.response.body.items).
      return data.items || data.response?.body?.items || [];
    },
    mapRaw(raw) {
      // TODO: 실제 필드명 확인 후 후보 배열을 채워 넣으세요. 아래는 공공데이터포털에서
      // 흔히 쓰이는 필드명을 추정해 넣은 임시값입니다.
      return {
        title: pickField(raw, ["title", "bsnsTitl", "pblancNm"]),
        desc: pickField(raw, ["content", "description", "bsnsSumryCn"]),
        target: pickField(raw, ["target", "trgetNm"]),
        tags: pickField(raw, ["hashtags"]),
        period: pickField(raw, ["period", "aplyPd", "reqstBeginEndDe"]),
        agency: pickField(raw, ["agency", "instNm"]) || "중소벤처24",
        url: pickField(raw, ["url", "pageUrl"]) || "https://www.smes.go.kr",
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
      const url = withServiceKey(endpoint, process.env.SME24_EVENT_API_KEY);
      const data = await fetchJson(url);
      // TODO: 실제 응답의 배열 경로로 조정하세요.
      return data.items || data.response?.body?.items || [];
    },
    mapRaw(raw) {
      // TODO: 실제 필드명 확인 후 채워 넣으세요.
      return {
        title: pickField(raw, ["title", "eventNm"]),
        desc: pickField(raw, ["content", "description"]),
        target: pickField(raw, ["target"]),
        tags: pickField(raw, ["hashtags"]),
        period: pickField(raw, ["period", "eventPd"]),
        agency: pickField(raw, ["agency", "instNm"]) || "중소벤처24",
        url: pickField(raw, ["url"]) || "https://www.smes.go.kr",
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
      const POWER_PLANT_SUBSIDY_RE = /발전소.*기본지원사업|기본지원사업.*발전소/;
      // "OO감시단"(민간 감시인력 모집)도 회사 지원사업이 아니라 개인 위촉 성격입니다.
      const CITIZEN_MONITOR_RE = /감시단|모니터링단/;
      // 2026-08-18 추가: "영광군 건강증진형 스마트경로당 구축사업" 등 경로당(공공 복지시설)
      // 구축·리모델링 사업, "한-베트남·몽골 유통물류 정책협력사업" 등 정부간 정책협력 활동.
      const NON_APPLICABLE_RE =
        /실태조사|종합상황실|학술활동|학술대회|정책\s*포럼|포럼$|경제협력\s*네트워크|산업통상\s*협력|시장조사|가입\s*지원$|비즈니스\s*파트너십|경제통상\s*정책|지방정부\s*협력|경상보조|위탁운영|\(주\)|㈜|\(유\)|경로당|정책협력/;
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
      const BROADCASTER_COMMISSION_RE = /^.{0,15}(MBC|KBS|SBS|KNN|방송공사|문화방송)/;
      function isApplicableProgram(item) {
        const name = pickField(item, ["DDTLBZ_NM", "DTLBZ_NM"]);
        if (NON_APPLICABLE_RE.test(name)) return false;
        if (isGovernmentHostedEvent(name)) return false;
        if (POWER_PLANT_SUBSIDY_RE.test(name)) return false;
        if (CITIZEN_MONITOR_RE.test(name)) return false;
        if (name.includes("_") && BROADCASTER_COMMISSION_RE.test(name)) return false;
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
      // 보이므로 대표 1건만 남기고 합칩니다.
      // 같은 사업인데도 표기만 다른 경우(예: "Jump-Up" vs "JUMP-UP" vs "Jump-up", 괄호 안팎
      // 띄어쓰기 차이)가 있어서 원문 그대로 비교하면 중복 제거가 안 됩니다(2026-08-18 발견:
      // "2026년 도약(Jump-Up) 프로그램"이 표기 차이로 5건 넘게 남아있던 문제). 대소문자·공백·
      // 괄호를 무시하고 비교하되, 실제로 저장/표시하는 제목은 원문 그대로 둡니다.
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

function buildTextBlob(normalized) {
  return [normalized.title, normalized.desc, normalized.target, normalized.tags].join(" \n ");
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

const INDUSTRY_RULES = [
  // "제조업"이라는 정확한 단어 없이 "제조DX", "스마트공장", "제조혁신 전문가" 같은 표현만
  // 쓰는 공고가 많아서(예: "제조DX멘토단 활용지원" 15건 중 14건이 industries:"all"로 잘못
  // 넓어졌던 문제, 2026-08-14 발견) 제조업 특화임이 명백한 표현들을 추가했습니다.
  // 2026-08-18 추가: "로봇산업기술개발사업" 등 로봇 특화 R&D가 제조업 키워드 없이 나오던 문제.
  { code: "mfg", keywords: ["제조업", "스마트공장", "제조혁신", "제조DX", "제조데이터", "자동화 설비", "로봇"] },
  // 2026-08-18 추가: "5G 기반 통신망 서비스" 등 통신 인프라 특화 사업.
  { code: "it", keywords: ["정보통신", "소프트웨어", "IT", "5G", "통신망"] },
  // 2026-08-18 추가: "AI 응용제품 신속 상용화(보건분야, 만성질환관리)" 등 "보건" 표현만 쓰는
  // 사업이 걸러지지 않던 문제.
  { code: "bio", keywords: ["바이오", "헬스케어", "제약", "보건"] },
  // 2026-08-18 추가: 방송·미디어·OTT 관련 사업이 "콘텐츠" 키워드가 본문에 없어서
  // industries:"all"로 잘못 넓어지던 문제(예: "지역 방송 제작역량 강화", "OTT산업 경쟁력 강화",
  // "AI 더빙 특화 K-FAST 확산") - 방송/미디어 특화 표현들을 추가했습니다.
  { code: "content", keywords: ["콘텐츠", "게임", "영상", "웹툰", "방송", "미디어", "OTT", "더빙"] },
  // 2026-08-18 추가: "국)식문화개선지원" 등 "식문화" 표현만 쓰는 농식품 관련 사업.
  { code: "agri", keywords: ["농식품", "농업", "축산", "수산", "임업", "산림", "목재", "식문화"] },
  // 2026-08-18 추가: "플랜트-EPC" 등 플랜트·엔지니어링 특화 사업이 걸러지지 않던 문제.
  // 2026-08-18 추가: "한옥전문인력양성" 등 한옥·전통건축 특화 사업, "디지털도로 AI 신기술
  // 지원사업" 등 도로·교통 인프라 특화 사업(국토교통부).
  { code: "construction", keywords: ["건설업", "플랜트", "한옥", "도로", "교통인프라"] },
  // 2026-08-18 추가: "시장상권인프라조성(시장경영지원)" 등 전통시장 상인 대상 사업.
  { code: "retail", keywords: ["도소매업", "유통업", "전통시장", "시장경영"] },
  // 2026-08-18 추가: "스포츠산업 선도기업 육성", "관광교통" 등 실제로는 특정 업종(스포츠산업/
  // 관광업) 대상인 문화체육관광부 사업이 industries:"all"로 잘못 넓어지던 문제.
  { code: "service", keywords: ["서비스업", "스포츠산업", "스포츠기업", "관광"] },
  // 2026-08-14 추가: 기후에너지환경부류 사업(온실가스/분산에너지/녹색산업 등)이 기존 8개
  // 업종 어디에도 안 맞아 계속 industries:"all"로 빠지던 문제 - "에너지·환경" 업종을 새로 만듦.
  // 2026-08-18 추가: "수소기업", "재자원화 시설" 등도 같은 부류라 키워드 보강.
  { code: "energy", keywords: ["에너지", "환경", "온실가스", "탄소중립", "신재생", "미세먼지", "자원순환", "녹색산업", "수소", "재자원화", "물기업"] },
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
  { code: "gyeonggi", keywords: ["경기도", "경기 "] },
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
const STARTUP_ONLY_KEYWORDS = ["창업기업", "창업 기업", "창업자 ", "초기창업", "창업초기", "창업벤처"];

function matchMaxYears(text) {
  const explicit = text.match(/(?:업력|창업|설립)\s*(?:후|일로부터)?\s*(\d{1,2})\s*년\s*(?:미만|이내)/);
  if (explicit) return Number(explicit[1]);
  if (includesAny(text, STARTUP_ONLY_KEYWORDS)) return 7;
  return null;
}

function tagAndBuildPolicy(normalized, source) {
  const text = buildTextBlob(normalized);
  const category = matchCategory(text);
  const sizes = matchMany(text, SIZE_RULES) || ["sole", "sme"]; // 명시 안 되면 가장 흔한 대상으로 넓게 잡음
  const founderTypes = matchMany(text, FOUNDER_TYPE_RULES);
  const certs = matchMany(text, CERT_RULES);
  let industries = matchAllOr(text, INDUSTRY_RULES);
  if (industries === "all" && AGENCY_INDUSTRY_HINTS[normalized.agency]) {
    industries = AGENCY_INDUSTRY_HINTS[normalized.agency];
  }
  const regions = matchAllOr(text, REGION_RULES);
  const maxYears = matchMaxYears(text);
  const exportRequired = includesAny(text, ["수출실적 보유", "수출 실적이 있는"]);
  const rndRequired = includesAny(text, ["부설연구소 보유", "연구전담부서 보유"]);
  const insuranceRequired = includesAny(text, ["고용보험 가입 사업장"]);
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
  const autoPolicies = [];
  for (const source of SOURCES) {
    autoPolicies.push(...(await collectFromSource(source)));
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
