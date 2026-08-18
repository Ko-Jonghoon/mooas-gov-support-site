import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "rnd-history.json");

// ---------------------------------------------------------------------------
// NTIS(국가과학기술지식정보서비스) "국가R&D 과제검색 서비스(전체용)" 수집 스크립트.
//
// fetch-and-tag.mjs와 별도 파일로 분리한 이유: 이 API는 "지금 신청 가능한 공고"가 아니라
// "이미 승인·수행된 국가R&D 과제의 메타정보(수행기관/예산/연구기간 등)" 검색 서비스라서,
// data/policies.json(공고 목록 + 신청자격 매칭)과는 데이터 성격이 완전히 다릅니다.
// 대신 "우리 업종/키워드로 어떤 정부 R&D 프로그램이 반복적으로 운영되어 왔는지" 파악하는
// 용도로 써서 data/rnd-history.json에 별도 저장하고, 사이트의 "R&D 이력" 탭에서 보여줍니다.
//
// 검색어(query) 없이는 호출할 수 없는 API라서, NTIS_KEYWORDS(.env.local)에 등록한 키워드로만
// 수집합니다. 키워드를 늘리고 싶으면 .env.local의 NTIS_KEYWORDS에 쉼표로 추가하세요.
// ---------------------------------------------------------------------------

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

const ENDPOINT = "https://www.ntis.go.kr/rndopen/openApi/public_project";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_KEYWORD = 5; // 키워드당 최대 500건까지만 수집(과도한 호출 방지)

async function fetchXml(url, timeoutMs = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${String(url).split("?")[0]}) - ${bodyText.slice(0, 300)}`);
  }
  // apprvKey가 틀리거나 만료된 경우 NTIS가 200 OK로 에러 메시지만 담긴 본문을 줄 수 있어서,
  // 정상 응답의 최상위 태그(<RESULT>)가 없으면 그 자체를 에러로 취급합니다.
  if (!bodyText.includes("<RESULT")) {
    throw new Error(`예상한 <RESULT> 응답이 아닙니다 - ${bodyText.slice(0, 300)}`);
  }
  return bodyText;
}

function tagContent(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`);
  const m = xml.match(re);
  return m ? m[1] : "";
}

function splitHits(xml) {
  const re = /<HIT\b[^>]*>([\s\S]*?)<\/HIT>/g;
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

// NTIS 응답은 검색어 하이라이트를 <span class="search_word">...</span>로 감싸서 돌려주는데,
// 그 태그 자체도 &lt;span...&gt;처럼 한 번 이스케이프된 채로 들어있습니다. 그래서 엔티티를
// 먼저 풀고, 그 결과로 드러난 태그를 다시 벗겨내는 두 단계가 필요합니다.
function stripHtml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ymdToIso(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return "";
  return yyyymmdd.slice(0, 4) + "-" + yyyymmdd.slice(4, 6) + "-" + yyyymmdd.slice(6, 8);
}

function leaf(hitXml, name) {
  return stripHtml(tagContent(hitXml, name));
}

function nestedLeaf(hitXml, parentName, childName) {
  return stripHtml(tagContent(tagContent(hitXml, parentName), childName));
}

function parseHit(hitXml) {
  const projectNumber = leaf(hitXml, "ProjectNumber");
  return {
    projectNumber,
    titleKo: nestedLeaf(hitXml, "ProjectTitle", "Korean"),
    titleEn: nestedLeaf(hitXml, "ProjectTitle", "English"),
    manager: nestedLeaf(hitXml, "Manager", "Name"),
    researchAgency: nestedLeaf(hitXml, "ResearchAgency", "Name"),
    orderAgency: nestedLeaf(hitXml, "OrderAgency", "Name"),
    ministry: nestedLeaf(hitXml, "Ministry", "Name"),
    budgetProgram: nestedLeaf(hitXml, "BudgetProject", "Name"),
    bigProjectTitle: leaf(hitXml, "BigprojectTitle"),
    projectYear: leaf(hitXml, "ProjectYear"),
    periodStart: ymdToIso(nestedLeaf(hitXml, "ProjectPeriod", "Start")),
    periodEnd: ymdToIso(nestedLeaf(hitXml, "ProjectPeriod", "End")),
    totalStart: nestedLeaf(hitXml, "ProjectPeriod", "TotalStart").slice(0, 10),
    totalEnd: nestedLeaf(hitXml, "ProjectPeriod", "TotalEnd").slice(0, 10),
    governmentFunds: Number(leaf(hitXml, "GovernmentFunds")) || 0,
    totalFunds: Number(leaf(hitXml, "TotalFunds")) || 0,
    keywordKo: nestedLeaf(hitXml, "Keyword", "Korean"),
    keywordEn: nestedLeaf(hitXml, "Keyword", "English"),
    detailUrl: projectNumber ? `https://www.ntis.go.kr/project/pjtInfo.do?pjtId=${projectNumber}` : "https://www.ntis.go.kr",
  };
}

async function fetchKeyword(keyword) {
  const results = [];
  let totalHits = null;

  for (let page = 0; page < MAX_PAGES_PER_KEYWORD; page++) {
    const url = new URL(ENDPOINT);
    url.searchParams.set("apprvKey", process.env.NTIS_APPRV_KEY);
    url.searchParams.set("collection", "project");
    url.searchParams.set("query", keyword);
    url.searchParams.set("searchField", "BI");
    url.searchParams.set("displayCount", String(PAGE_SIZE));
    url.searchParams.set("startPosition", String(page * PAGE_SIZE + 1));
    url.searchParams.set("cmbnApiYn", "Y");

    const xml = await fetchXml(url.toString());
    if (totalHits === null) {
      totalHits = Number(tagContent(xml, "TOTALHITS")) || 0;
    }
    const hits = splitHits(xml);
    if (!hits.length) break;
    for (const hitXml of hits) results.push(parseHit(hitXml));
    if (results.length >= totalHits) break;
  }

  if (totalHits !== null && results.length < totalHits) {
    console.log(
      `[NTIS] "${keyword}" 전체 ${totalHits}건 중 ${results.length}건만 수집(키워드당 최대 ${MAX_PAGES_PER_KEYWORD * PAGE_SIZE}건 제한).`
    );
  }
  return results;
}

function buildProgramSummary(projects) {
  const byProgram = new Map();
  for (const p of projects) {
    if (!p.budgetProgram) continue;
    const key = p.budgetProgram + "||" + p.ministry;
    if (!byProgram.has(key)) {
      byProgram.set(key, { name: p.budgetProgram, ministry: p.ministry, count: 0, totalGovernmentFunds: 0, years: new Set() });
    }
    const entry = byProgram.get(key);
    entry.count += 1;
    entry.totalGovernmentFunds += p.governmentFunds;
    if (p.projectYear) entry.years.add(p.projectYear);
  }
  return [...byProgram.values()]
    .map((e) => ({
      name: e.name,
      ministry: e.ministry,
      count: e.count,
      totalGovernmentFunds: e.totalGovernmentFunds,
      years: [...e.years].sort(),
    }))
    .sort((a, b) => b.count - a.count);
}

async function main() {
  if (!process.env.NTIS_APPRV_KEY) {
    console.log("[NTIS] NTIS_APPRV_KEY가 없어 건너뜁니다. scripts/.env.local.example 참고.");
    return;
  }
  const keywords = (process.env.NTIS_KEYWORDS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!keywords.length) {
    console.log("[NTIS] NTIS_KEYWORDS가 비어있어 건너뜁니다.");
    return;
  }

  const byProjectNumber = new Map();
  for (const keyword of keywords) {
    let hits;
    try {
      hits = await fetchKeyword(keyword);
    } catch (err) {
      console.error(`[NTIS] "${keyword}" 수집 실패, 이 키워드는 건너뜁니다:`, err.message);
      continue;
    }
    console.log(`[NTIS] "${keyword}" ${hits.length}건 수집.`);
    for (const hit of hits) {
      if (!hit.projectNumber) continue;
      const existing = byProjectNumber.get(hit.projectNumber);
      if (existing) {
        if (!existing.matchedKeywords.includes(keyword)) existing.matchedKeywords.push(keyword);
      } else {
        byProjectNumber.set(hit.projectNumber, { ...hit, matchedKeywords: [keyword] });
      }
    }
  }

  const projects = [...byProjectNumber.values()].sort((a, b) => Number(b.projectYear) - Number(a.projectYear));
  const programs = buildProgramSummary(projects);

  const out = {
    generatedAt: new Date().toISOString(),
    keywords,
    note:
      "NTIS 국가R&D 과제검색 서비스(전체용) 결과입니다. '지금 신청 가능한 공고'가 아니라 이미 " +
      "수행되었거나 수행 중인 국가R&D 과제 이력이며, 어떤 정부 R&D 프로그램이 우리 업종/키워드에서 " +
      "반복적으로 운영되어 왔는지 참고하는 용도입니다. 실제 공모 여부는 소관 부처·전문기관 공고를 " +
      "별도로 확인하세요.",
    programs,
    projects,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`data/rnd-history.json 갱신 완료: 과제 ${projects.length}건, 프로그램 ${programs.length}개`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
