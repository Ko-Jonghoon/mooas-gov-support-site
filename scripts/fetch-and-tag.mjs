import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "policies.json");

// scripts/.env.local (git에 올라가지 않는 파일)에 BIZINFO_API_KEY=값 형태로 한 번만
// 저장해두면, 이후로는 run-fetch.bat 더블클릭만으로 실행할 수 있습니다.
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

const BIZINFO_API_KEY = process.env.BIZINFO_API_KEY;

if (!BIZINFO_API_KEY) {
  console.error(
    "BIZINFO_API_KEY가 없습니다. scripts/.env.local 파일을 만들고 BIZINFO_API_KEY=발급받은키 형태로 한 줄 넣어주세요.\n" +
    "(scripts/.env.local.example 파일을 참고하세요)"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1) 기업마당(bizinfo.go.kr) Open API에서 최신 지원사업 공고 원본 목록 가져오기
//
// 엔드포인트/파라미터는 bizinfo.go.kr/apiDetail.do?id=bizinfoApi 공식 안내 기준으로 확인됨:
//   - GET https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do
//   - 필수: crtfcKey (신청 즉시 발급되는 인증키)
//   - 선택: dataType(json/rss), searchCnt, searchLclasId(분야 01~09), hashtags, pageUnit, pageIndex
// 다만 정확한 JSON 응답 필드명(배열 경로 등)은 실제 키로 호출해 응답을 한 번 찍어보고
// 아래 "data.jsonArray || data.items" 부분을 필요시 조정하세요.
// ---------------------------------------------------------------------------
async function fetchRawAnnouncements() {
  const url = new URL("https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do");
  url.searchParams.set("crtfcKey", BIZINFO_API_KEY);
  url.searchParams.set("dataType", "json");
  url.searchParams.set("searchCnt", "100");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`기업마당 API 호출 실패: HTTP ${res.status}`);
  }
  const data = await res.json();
  // TODO: 실제 응답 스키마에 맞춰 배열 경로를 조정하세요
  // (예: data.jsonArray, data.response.body.items 등 - 명세서 확인 필요)
  return data.jsonArray || data.items || [];
}

// ---------------------------------------------------------------------------
// 2) 규칙(키워드) 기반 태깅
//
// LLM 없이, 공고 원문에 특정 키워드가 있는지로 우리 매칭 스키마의 조건을 채웁니다.
// 정확도는 LLM 태깅보다 낮을 수 있으니, 모든 자동 수집 항목은 reviewed:false로
// 표시되어 사람이 검수하기 전까지 사이트에 "자동수집 · 검수대기" 배지가 붙습니다.
//
// 실제 기업마당 응답의 필드명을 확인한 뒤, 아래 candidateFields를 필요에 맞게 조정하세요.
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

function buildTextBlob(raw) {
  const title = pickField(raw, ["pblancNm", "title", "bsnsTitl"]);
  const desc = pickField(raw, ["bsnsSumryCn", "content", "cn", "description"]);
  const target = pickField(raw, ["trgetNm", "target", "reqstTrgetNm"]);
  const tags = pickField(raw, ["hashtags", "hashTag"]);
  return [title, desc, target, tags].join(" \n ");
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

function tagAnnouncementByRules(raw) {
  const text = buildTextBlob(raw);
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

  const name = pickField(raw, ["pblancNm", "title", "bsnsTitl"]) || "이름 미확인 공고";
  const descRaw = pickField(raw, ["bsnsSumryCn", "content", "cn", "description"]);
  const period = pickField(raw, ["reqstBeginEndDe", "period", "aplyPd"]);
  const target = pickField(raw, ["trgetNm", "target", "reqstTrgetNm"]);

  const summarySource = descRaw || name;
  const summary = summarySource.slice(0, 90) + (summarySource.length > 90 ? "…" : "");

  const benefits = [];
  if (descRaw) benefits.push({ label: "지원내용", value: descRaw.slice(0, 200) + (descRaw.length > 200 ? "…(원문 확인 필요)" : "") });
  if (target) benefits.push({ label: "지원대상", value: target.slice(0, 150) });
  if (period) benefits.push({ label: "신청기간", value: period });
  if (!benefits.length) benefits.push({ label: "안내", value: "공고 원문에서 자동 추출된 상세 내용이 없습니다. 공식 사이트에서 확인하세요." });

  return {
    name,
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
  };
}

function loadExisting() {
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  return JSON.parse(raw);
}

function makeId(name, agency) {
  return "auto-" + Buffer.from(`${name}|${agency}`).toString("base64url").slice(0, 16);
}

async function main() {
  const existing = loadExisting();
  const manualEntries = existing.policies.filter((p) => p.source === "manual-seed");

  const rawList = await fetchRawAnnouncements();
  console.log(`기업마당에서 ${rawList.length}건의 공고를 가져왔습니다.`);

  const autoPolicies = [];
  for (const raw of rawList) {
    try {
      const tagged = tagAnnouncementByRules(raw);
      const agency = pickField(raw, ["jrsdInsttNm", "agency", "instNm"]) || "확인 필요";
      autoPolicies.push({
        id: makeId(tagged.name, agency),
        name: tagged.name,
        agency,
        url: pickField(raw, ["pblancUrl", "url", "pageUrl"]) || "https://www.bizinfo.go.kr",
        category: tagged.category,
        summary: tagged.summary,
        benefits: tagged.benefits,
        elig: tagged.elig,
        source: "auto",
        reviewed: false,
      });
    } catch (err) {
      console.error("태깅 실패, 이 공고는 건너뜁니다:", err.message);
    }
  }

  const merged = [...manualEntries, ...autoPolicies];

  const out = {
    generatedAt: new Date().toISOString(),
    note: "기업마당 Open API 자동 수집 + 키워드 규칙 기반 자동 태깅 결과. source:auto 항목은 사람이 검수(reviewed:true로 변경)하기 전까지 화면에 '자동수집 · 검수대기' 표시가 붙습니다. 규칙 기반 태깅은 LLM보다 정확도가 낮을 수 있으니 반드시 검수 후 병합하세요.",
    policies: merged,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`data/policies.json 갱신 완료: 수동 시드 ${manualEntries.length}건 + 자동 수집 ${autoPolicies.length}건`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
