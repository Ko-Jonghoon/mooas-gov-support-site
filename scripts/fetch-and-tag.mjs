import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "policies.json");

const BIZINFO_API_KEY = process.env.BIZINFO_API_KEY;
// 비용을 낮추고 싶다면 워크플로/로컬 환경변수로 ANTHROPIC_MODEL=claude-haiku-4-5 등을
// 직접 지정하세요. 기본값은 품질을 우선한 claude-opus-5 입니다.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

if (!BIZINFO_API_KEY) {
  console.error(
    "BIZINFO_API_KEY 환경변수가 필요합니다. 기업마당(bizinfo.go.kr) Open API 활용신청 후 발급받은 키를 설정하세요."
  );
  process.exit(1);
}

const client = new Anthropic(); // ANTHROPIC_API_KEY 환경변수를 자동으로 사용합니다

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

const INDUSTRY_CODES = ["mfg", "it", "service", "retail", "construction", "agri", "bio", "content", "etc"];
const REGION_CODES = [
  "seoul", "busan", "daegu", "incheon", "gwangju", "daejeon", "ulsan", "sejong",
  "gyeonggi", "gangwon", "chungbuk", "chungnam", "jeonbuk", "jeonnam", "gyeongbuk", "gyeongnam", "jeju",
];

const ELIGIBILITY_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "지원사업명" },
    category: {
      type: "string",
      enum: ["fund", "rnd", "ai", "hr", "export", "market", "facility", "consulting", "esg", "smart", "etc"],
    },
    summary: { type: "string", description: "지원사업을 한 문장으로 요약" },
    benefits: {
      type: "array",
      description: "지원금액/지원내용/지원기간 등 구체적 혜택 2~4개",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "예: 지원금액, 우대혜택, 지원기간" },
          value: { type: "string" },
        },
        required: ["label", "value"],
        additionalProperties: false,
      },
    },
    elig: {
      type: "object",
      properties: {
        sizes: {
          type: "array",
          items: { type: "string", enum: ["pre", "sole", "sme", "mid"] },
          description: "예비창업자/소상공인/중소기업/중견기업 중 대상",
        },
        industries: {
          anyOf: [
            { type: "string", enum: ["all"] },
            { type: "array", items: { type: "string", enum: INDUSTRY_CODES } },
          ],
        },
        regions: {
          anyOf: [
            { type: "string", enum: ["all"] },
            { type: "array", items: { type: "string", enum: REGION_CODES } },
          ],
        },
        maxYears: { type: ["number", "null"], description: "업력 몇 년 이내 대상인지, 없으면 null" },
        founderTypes: {
          type: ["array", "null"],
          items: { type: "string", enum: ["youth", "woman", "disabled", "senior"] },
        },
        certs: {
          type: ["array", "null"],
          items: { type: "string", enum: ["venture", "innobiz", "mainbiz", "social", "root"] },
        },
        exportRequired: { type: "boolean" },
        rndRequired: { type: "boolean" },
        insuranceRequired: { type: "boolean" },
        taxClean: { type: "boolean", description: "국세/지방세 체납 없어야 신청 가능한 사업인지" },
      },
      required: [
        "sizes", "industries", "regions", "maxYears", "founderTypes", "certs",
        "exportRequired", "rndRequired", "insuranceRequired", "taxClean",
      ],
      additionalProperties: false,
    },
  },
  required: ["name", "category", "summary", "benefits", "elig"],
  additionalProperties: false,
};

async function tagAnnouncement(raw) {
  const prompt = `다음은 한국 정부/공공기관 지원사업 공고 원문(JSON)입니다. 이 공고를 우리 회사의 지원사업 매칭 시스템 스키마에 맞게 구조화하세요.

지침:
- category는 사업 성격에 가장 가까운 것 하나만 선택하세요.
- benefits는 공고 원문에 실제로 나온 지원금액/지원내용/지원기간 등을 2~4개의 라벨-값 쌍으로 정리하세요. 원문에 없는 수치나 조건을 지어내지 마세요.
- elig(자격요건)은 원문에서 명시적으로 확인되는 조건만 반영하고, 확인되지 않으면 industries/regions는 "all", 나머지 필드는 null 또는 false로 두어 보수적으로 처리하세요(과도한 제외를 피하기 위함).
- 확신이 없는 항목은 반드시 넓게(제한 없음 쪽으로) 잡으세요 — 나중에 사람이 검수합니다.

공고 원문:
"""
${JSON.stringify(raw).slice(0, 6000)}
"""`;

  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: { type: "json_schema", schema: ELIGIBILITY_SCHEMA } },
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("모델 응답에서 text 블록을 찾을 수 없습니다");
  return JSON.parse(textBlock.text);
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
      const tagged = await tagAnnouncement(raw);
      const agency = raw.agency || raw.jrsdInsttNm || "확인 필요";
      autoPolicies.push({
        id: makeId(tagged.name, agency),
        name: tagged.name,
        agency,
        url: raw.url || raw.pblancUrl || "https://www.bizinfo.go.kr",
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
    note: "기업마당 Open API 자동 수집 + LLM(Claude) 자동 태깅 결과. source:auto 항목은 사람이 검수(reviewed:true로 변경)하기 전까지 화면에 '자동수집 · 검수대기' 표시가 붙습니다.",
    policies: merged,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`data/policies.json 갱신 완료: 수동 시드 ${manualEntries.length}건 + 자동 수집 ${autoPolicies.length}건`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
