import fs from "fs";
import path from "path";
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

async function fetchJson(url) {
  const res = await fetch(url);
  const bodyText = await res.text();
  if (!res.ok) {
    // data.go.kr류 API는 400/401 응답 본문(XML/JSON)에 정확한 실패 사유가 들어있는 경우가
    // 많아서(예: 필수 파라미터 누락, 서비스키 미승인 등) 본문 앞부분을 그대로 보여줍니다.
    throw new Error(`HTTP ${res.status} (${url.origin}${url.pathname}) - ${bodyText.slice(0, 300)}`);
  }
  return JSON.parse(bodyText);
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
    envKey: "SME24_API_KEY",
    async fetchRaw() {
      // TODO: 공공데이터포털에서 발급받은 실제 엔드포인트/파라미터명으로 교체하세요.
      // 엔드포인트를 scripts/.env.local의 SME24_ANNOUNCE_ENDPOINT로 넣어두면
      // 여기서 바로 사용합니다(문서 확인 전 임시 기본값).
      const endpoint = process.env.SME24_ANNOUNCE_ENDPOINT;
      if (!endpoint) {
        console.log("[중소벤처24 공고정보] SME24_ANNOUNCE_ENDPOINT가 없어 건너뜁니다. .env.local.example 참고.");
        return [];
      }
      const url = new URL(endpoint);
      url.searchParams.set("serviceKey", process.env.SME24_API_KEY);
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
    envKey: "SME24_API_KEY",
    async fetchRaw() {
      const endpoint = process.env.SME24_EVENT_ENDPOINT;
      if (!endpoint) {
        console.log("[중소벤처24 행사정보] SME24_EVENT_ENDPOINT가 없어 건너뜁니다. .env.local.example 참고.");
        return [];
      }
      const url = new URL(endpoint);
      url.searchParams.set("serviceKey", process.env.SME24_API_KEY);
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
      const url = new URL(endpoint);
      url.searchParams.set("serviceKey", process.env.KSTARTUP_API_KEY);
      const data = await fetchJson(url);
      // TODO: 실제 응답의 배열 경로로 조정하세요.
      return data.items || data.data || [];
    },
    mapRaw(raw) {
      // TODO: 실제 필드명 확인 후 채워 넣으세요.
      return {
        title: pickField(raw, ["biz_pbanc_nm", "title"]),
        desc: pickField(raw, ["pbanc_ctnt", "content"]),
        target: pickField(raw, ["aply_trgt_ctnt", "target"]),
        tags: pickField(raw, ["hashtags"]),
        period: pickField(raw, ["pbanc_rcpt_bgng_dt", "period"]),
        agency: pickField(raw, ["pbanc_ntrp_nm", "agency"]) || "K-Startup",
        url: pickField(raw, ["detl_pg_url", "url"]) || "https://www.k-startup.go.kr",
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
      const url = new URL(endpoint);
      url.searchParams.set("serviceKey", process.env.MPB_API_KEY);
      const data = await fetchJson(url);
      // TODO: 실제 응답의 배열 경로로 조정하세요.
      return data.items || [];
    },
    mapRaw(raw) {
      // TODO: 실제 필드명 확인 후 채워 넣으세요.
      return {
        title: pickField(raw, ["title"]),
        desc: pickField(raw, ["content", "description"]),
        target: pickField(raw, ["target"]),
        tags: pickField(raw, ["hashtags"]),
        period: pickField(raw, ["period"]),
        agency: pickField(raw, ["agency"]) || "기획재정부",
        url: pickField(raw, ["url"]) || "https://www.moef.go.kr",
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
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
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
  { code: "sole", keywords: ["소상공인"] },
  { code: "sme", keywords: ["중소기업"] },
  { code: "mid", keywords: ["중견기업"] },
];

const INDUSTRY_RULES = [
  { code: "mfg", keywords: ["제조업"] },
  { code: "it", keywords: ["정보통신", "소프트웨어", "IT"] },
  { code: "bio", keywords: ["바이오", "헬스케어", "제약"] },
  { code: "content", keywords: ["콘텐츠", "게임", "영상", "웹툰"] },
  { code: "agri", keywords: ["농식품", "농업", "축산", "수산"] },
  { code: "construction", keywords: ["건설업"] },
  { code: "retail", keywords: ["도소매업", "유통업"] },
  { code: "service", keywords: ["서비스업"] },
];

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
  const hits = rules.filter((r) => includesAny(text, r.keywords)).map((r) => r.code);
  return hits.length ? hits : "all";
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
  const industries = matchAllOr(text, INDUSTRY_RULES);
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
  return "auto-" + Buffer.from(`${name}|${agency}`).toString("base64url").slice(0, 16);
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
