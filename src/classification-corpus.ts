import { createHash } from "node:crypto";

import {
  CAPABILITY_SIGNAL_NAMES,
  CLASSIFICATION_TEMPLATE_VERSION,
  type CapabilitySignalName,
  type TaskClassificationV1,
} from "./classification-provider.js";

/**
 * Versioned classification corpus for the current classification template.
 *
 * The corpus is bound to CLASSIFICATION_TEMPLATE_VERSION: any substantive
 * change to the classification template requires a new template version and a
 * complete rerun of this corpus before the real Jev compatibility gate may run.
 */
export const CLASSIFICATION_CORPUS_ID = "classification-v1";

export const CLASSIFICATION_BOUNDARIES = [
  "verbosity-not-reasoning",
  "software-topic-not-code",
  "local-repo-not-research",
  "ambiguous-low-confidence",
] as const;
export type ClassificationBoundary = (typeof CLASSIFICATION_BOUNDARIES)[number];

/** Canonical name for the corpus's Boolean Capability Signal vectors. */
export type ClassificationBooleanVector = Record<CapabilitySignalName, boolean>;

export interface ClassificationCorpusEntry {
  /** Stable corpus-unique identifier, e.g. "classification-v1/001". */
  id: string;
  /** Complete, unmodified user message handed to the Classification Provider. */
  message: string;
  /** Expected Boolean Capability Signal vector (codeWork/deepReasoning/externalResearch). */
  expected: ClassificationBooleanVector;
  /** Clear examples must route confidently; ambiguous examples must fail open on low confidence. */
  clarity: "clear" | "ambiguous";
  /** Semantic boundary this example documents, when it is a boundary example. */
  boundary?: ClassificationBoundary;
}

/** The versioned corpus contract: 24 messages, 22 clear, 2 ambiguous. */
export const CLASSIFICATION_CORPUS_SIZE = 24;
export const CLASSIFICATION_CORPUS_CLEAR_EXAMPLES = 22;
export const CLASSIFICATION_CORPUS_AMBIGUOUS_EXAMPLES = 2;

/** All eight Boolean Capability Signal combinations in fixed order. */
export const CLASSIFICATION_BOOLEAN_VECTORS: readonly ClassificationBooleanVector[] = Array.from(
  { length: 8 },
  (_unused, mask): ClassificationBooleanVector => ({
    codeWork: (mask & 1) !== 0,
    deepReasoning: (mask & 2) !== 0,
    externalResearch: (mask & 4) !== 0,
  }),
);

/** Stable short key for a Boolean Capability Signal vector, e.g. "101". */
function vectorKey(values: Partial<ClassificationBooleanVector>): string {
  return CAPABILITY_SIGNAL_NAMES.map((name) => (values[name] === true ? "1" : "0")).join("");
}

function isCompleteBooleanVector(
  value: Partial<ClassificationBooleanVector> | undefined,
): value is ClassificationBooleanVector {
  return (
    value !== undefined &&
    CAPABILITY_SIGNAL_NAMES.every((name) => typeof value[name] === "boolean")
  );
}

type BooleanVector = ClassificationBooleanVector;

/** The 24 canonical messages from the accepted Task Classification contract (#7). */
export const CLASSIFICATION_CORPUS: readonly ClassificationCorpusEntry[] = [
  {
    id: "classification-v1/001",
    message: "把这句话改得更简洁：我们目前正在进行相关准备工作。",
    expected: { codeWork: false, deepReasoning: false, externalResearch: false },
    clarity: "clear",
  },
  {
    id: "classification-v1/002",
    message: "用两句话解释供需关系。",
    expected: { codeWork: false, deepReasoning: false, externalResearch: false },
    clarity: "clear",
  },
  {
    id: "classification-v1/003",
    message: "把下面函数改写为 async/await，保持行为不变：function load() { return fetch(\"/api/items\").then(r => r.json()); }",
    expected: { codeWork: true, deepReasoning: false, externalResearch: false },
    clarity: "clear",
  },
  {
    id: "classification-v1/004",
    message: "为下面的纯函数补齐等于边界和越界输入的测试：function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }",
    expected: { codeWork: true, deepReasoning: false, externalResearch: false },
    clarity: "clear",
  },
  {
    id: "classification-v1/005",
    message: "甲、乙、丙、丁四人排队；甲不在首尾，乙在丙之前，丁紧邻甲。列出所有可能顺序，并证明没有遗漏。",
    expected: { codeWork: false, deepReasoning: true, externalResearch: false },
    clarity: "clear",
  },
  {
    id: "classification-v1/006",
    message:
      "某项目必须在六周内完成，预算不得超过 20 万元，并且不能减少测试范围。方案 A 用时五周、成本 24 万；方案 B 用时七周、成本 18 万；方案 C 用时六周、成本 20 万但需要把两项工作串行改为并行。比较三个方案，给出选择并说明约束权衡。",
    expected: { codeWork: false, deepReasoning: true, externalResearch: false },
    clarity: "clear",
  },
  {
    id: "classification-v1/007",
    message: "查询 Node.js 官方网站，给出当前 LTS 主版本及链接。",
    expected: { codeWork: false, deepReasoning: false, externalResearch: true },
    clarity: "clear",
  },
  {
    id: "classification-v1/008",
    message: "从 OpenRouter 官方页面核验当前 Jev 输入价格，并引用来源。",
    expected: { codeWork: false, deepReasoning: false, externalResearch: true },
    clarity: "clear",
  },
  {
    id: "classification-v1/009",
    message:
      "诊断下面代码为何在两个方向同时转账时偶发死锁，并设计最小修复：async function transfer(from, to, n) { await from.lock(); await to.lock(); from.balance -= n; to.balance += n; to.unlock(); from.unlock(); }",
    expected: { codeWork: true, deepReasoning: true, externalResearch: false },
    clarity: "clear",
  },
  {
    id: "classification-v1/010",
    message:
      "现有 TypeScript 服务把事件按递增整数 ID 写入单个可变数组。新版本要改为按 stream ID 分区的不可变记录；升级期间不能停机，旧版本仍会运行 24 小时，而且任何事件都不能丢失或重复。设计代码迁移方案并说明如何验证切换安全。",
    expected: { codeWork: true, deepReasoning: true, externalResearch: false },
    clarity: "clear",
  },
  {
    id: "classification-v1/011",
    message:
      "查阅 React 19 官方迁移指南，把下面代码改为推荐 API，只做必要修改：ReactDOM.render(<App />, document.getElementById(\"root\"));",
    expected: { codeWork: true, deepReasoning: false, externalResearch: true },
    clarity: "clear",
  },
  {
    id: "classification-v1/012",
    message:
      "查阅当前 GitHub Actions 官方迁移说明，把下面 workflow 中已不受支持的 action 更新为受支持版本：steps: [{ uses: \"actions/cache@v2\" }]。",
    expected: { codeWork: true, deepReasoning: false, externalResearch: true },
    clarity: "clear",
  },
  {
    id: "classification-v1/013",
    message:
      "根据最新官方资料比较两种适用的合规方案；在必须三个月内上线、不能把个人数据移出欧盟、审计预算有限的约束下，推荐实施顺序并引用依据。",
    expected: { codeWork: false, deepReasoning: true, externalResearch: true },
    clarity: "clear",
  },
  {
    id: "classification-v1/014",
    message:
      "查找 PostgreSQL 和 CockroachDB 当前的官方许可说明与近期公开基准；针对跨三个区域写入、可接受最终一致读取、团队只有两名运维人员的场景作出选择并说明权衡。",
    expected: { codeWork: false, deepReasoning: true, externalResearch: true },
    clarity: "clear",
  },
  {
    id: "classification-v1/015",
    message:
      "查阅当前 CVE 官方公告，判断下面使用受影响依赖的代码路径是否可利用，并提供最小补丁及回归验证：const payload = vulnerableLib.parse(req.body); return run(payload);",
    expected: { codeWork: true, deepReasoning: true, externalResearch: true },
    clarity: "clear",
  },
  {
    id: "classification-v1/016",
    message:
      "根据最新 OAuth 2.1 官方规范审计下面仍使用隐式授权的认证实现，设计兼容现有移动客户端的迁移方案，并给出必要代码修改：authorize({ response_type: \"token\", client_id, redirect_uri });",
    expected: { codeWork: true, deepReasoning: true, externalResearch: true },
    clarity: "clear",
  },
  {
    id: "classification-v1/017",
    message: "用一千字详细介绍光合作用，不需要查询或引用资料。",
    expected: { codeWork: false, deepReasoning: false, externalResearch: false },
    clarity: "clear",
    boundary: "verbosity-not-reasoning",
  },
  {
    id: "classification-v1/018",
    message: "分十点详细复述下面提供的文章：春季学期共有十二周，前四周讲基础概念，中间四周做案例练习，最后四周完成小组项目。",
    expected: { codeWork: false, deepReasoning: false, externalResearch: false },
    clarity: "clear",
    boundary: "verbosity-not-reasoning",
  },
  {
    id: "classification-v1/019",
    message: "什么是语义化版本？",
    expected: { codeWork: false, deepReasoning: false, externalResearch: false },
    clarity: "clear",
    boundary: "software-topic-not-code",
  },
  {
    id: "classification-v1/020",
    message: "用通俗语言解释数据库索引。",
    expected: { codeWork: false, deepReasoning: false, externalResearch: false },
    clarity: "clear",
    boundary: "software-topic-not-code",
  },
  {
    id: "classification-v1/021",
    message: "在当前仓库找出所有 TODO，并列出文件位置。",
    expected: { codeWork: true, deepReasoning: false, externalResearch: false },
    clarity: "clear",
    boundary: "local-repo-not-research",
  },
  {
    id: "classification-v1/022",
    message: "读取当前仓库的 package.json，列出 scripts 和 dependencies。",
    expected: { codeWork: true, deepReasoning: false, externalResearch: false },
    clarity: "clear",
    boundary: "local-repo-not-research",
  },
  {
    id: "classification-v1/023",
    message: "帮我看看这个问题。",
    expected: { codeWork: false, deepReasoning: false, externalResearch: false },
    clarity: "ambiguous",
    boundary: "ambiguous-low-confidence",
  },
  {
    id: "classification-v1/024",
    message: "把它优化一下。",
    expected: { codeWork: false, deepReasoning: false, externalResearch: false },
    clarity: "ambiguous",
    boundary: "ambiguous-low-confidence",
  },
];

export interface ClassificationCorpusManifest {
  corpusId: string;
  templateVersion: string;
  messageCount: number;
  /** SHA-256 digest of the canonical corpus content; any in-place edit changes it. */
  contentDigest: string;
}

/** SHA-256 over the corpus entries in canonical order (id, message, expected, clarity, boundary). */
export function classificationCorpusContentDigest(
  entries: readonly ClassificationCorpusEntry[] = CLASSIFICATION_CORPUS,
): string {
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(
      JSON.stringify([
        entry.id,
        entry.message,
        entry.expected,
        entry.clarity,
        entry.boundary ?? null,
      ]),
    );
    digest.update("\n");
  }
  return digest.digest("hex");
}

/** The content digest of the shipped corpus; pinned by the deterministic tests. */
export const CLASSIFICATION_CORPUS_CONTENT_DIGEST = classificationCorpusContentDigest();

/** The version binding asserted before any corpus rerun or real gate execution. */
export const CLASSIFICATION_CORPUS_MANIFEST: ClassificationCorpusManifest = {
  corpusId: CLASSIFICATION_CORPUS_ID,
  templateVersion: CLASSIFICATION_TEMPLATE_VERSION,
  messageCount: CLASSIFICATION_CORPUS.length,
  contentDigest: CLASSIFICATION_CORPUS_CONTENT_DIGEST,
};

/** Whether a classification reproduces the entry's complete expected Boolean vector exactly. */
export function classificationMatchesExpected(
  entry: ClassificationCorpusEntry,
  classification: TaskClassificationV1,
): boolean {
  return CAPABILITY_SIGNAL_NAMES.every(
    (name) => classification.signals[name].value === entry.expected[name],
  );
}

/**
 * Deterministic structural validation of a classification corpus.
 *
 * Returns a sorted list of problems; an empty list means the corpus satisfies
 * the versioned contract: 24 unique messages, complete expected Boolean
 * vectors, all eight Boolean combinations covered by at least two clear
 * examples, exactly two ambiguous examples, and every canonical boundary
 * category present with a consistent expected vector.
 */
export function validateClassificationCorpus(
  entries: readonly ClassificationCorpusEntry[] = CLASSIFICATION_CORPUS,
): string[] {
  const errors = new Set<string>();
  const record = (error: string): void => {
    errors.add(error);
  };

  if (entries.length !== CLASSIFICATION_CORPUS_SIZE) {
    record(`corpus must contain exactly ${CLASSIFICATION_CORPUS_SIZE} messages, found ${entries.length}`);
  }

  const seenIds = new Set<string>();
  const seenMessages = new Set<string>();
  const clearVectorCounts = new Map<string, number>();

  for (const [index, entry] of entries.entries()) {
    const label =
      typeof entry?.id === "string" && entry.id.length > 0 ? entry.id : `entry ${index}`;

    if (typeof entry?.id !== "string" || entry.id.length === 0) {
      record(`${label} has an empty or missing id`);
    } else if (seenIds.has(entry.id)) {
      record(`${label} has a duplicate id`);
    } else {
      seenIds.add(entry.id);
    }

    if (typeof entry?.message !== "string" || entry.message.trim().length === 0) {
      record(`${label} has an empty message`);
    } else if (seenMessages.has(entry.message)) {
      record(`${label} duplicates the message of another entry`);
    } else {
      seenMessages.add(entry.message);
    }

    const expected = entry?.expected as Partial<ClassificationBooleanVector> | undefined;
    if (!expected || typeof expected !== "object") {
      record(`${label} has no expected Capability Signal object`);
    } else {
      for (const name of CAPABILITY_SIGNAL_NAMES) {
        if (typeof expected[name] !== "boolean") {
          record(`${label} has a non-Boolean expectation for ${name}`);
        }
      }
      if (entry.clarity === "clear") {
        const key = vectorKey(expected);
        clearVectorCounts.set(key, (clearVectorCounts.get(key) ?? 0) + 1);
      }
    }

    if (entry?.clarity !== "clear" && entry?.clarity !== "ambiguous") {
      record(`${label} has an invalid clarity ${JSON.stringify(entry?.clarity)}`);
    }

    const boundary = entry?.boundary;
    if (boundary !== undefined) {
      if (!CLASSIFICATION_BOUNDARIES.includes(boundary)) {
        record(`${label} has an unknown boundary ${JSON.stringify(boundary)}`);
      } else if (boundary === "ambiguous-low-confidence" && entry.clarity !== "ambiguous") {
        record(`${label} marks ambiguous-low-confidence but is not ambiguous`);
      } else if (boundary !== "ambiguous-low-confidence" && entry.clarity !== "clear") {
        record(`${label} marks boundary ${boundary} but is not clear`);
      } else if (isCompleteBooleanVector(expected)) {
        if (boundary === "verbosity-not-reasoning" && expected.deepReasoning !== false) {
          record(`${label} marks verbosity-not-reasoning but expects deep reasoning`);
        }
        if (boundary === "software-topic-not-code" && expected.codeWork !== false) {
          record(`${label} marks software-topic-not-code but expects code work`);
        }
        if (
          boundary === "local-repo-not-research" &&
          !(expected.codeWork === true && expected.externalResearch === false)
        ) {
          record(`${label} marks local-repo-not-research but does not expect code work without external research`);
        }
      }
    } else if (entry?.clarity === "ambiguous") {
      record(`${label} is ambiguous but does not mark the ambiguous-low-confidence boundary`);
    }
  }

  for (const vector of CLASSIFICATION_BOOLEAN_VECTORS) {
    const key = vectorKey(vector);
    const count = clearVectorCounts.get(key) ?? 0;
    if (count < 2) {
      record(`expected Boolean vector ${key} needs at least two clear examples, found ${count}`);
    }
  }

  const clearCount = entries.filter((entry) => entry?.clarity === "clear").length;
  const ambiguousCount = entries.filter((entry) => entry?.clarity === "ambiguous").length;
  if (clearCount !== CLASSIFICATION_CORPUS_CLEAR_EXAMPLES) {
    record(`corpus must contain exactly ${CLASSIFICATION_CORPUS_CLEAR_EXAMPLES} clear examples, found ${clearCount}`);
  }
  if (ambiguousCount !== CLASSIFICATION_CORPUS_AMBIGUOUS_EXAMPLES) {
    record(`corpus must contain exactly ${CLASSIFICATION_CORPUS_AMBIGUOUS_EXAMPLES} ambiguous examples, found ${ambiguousCount}`);
  }

  for (const boundary of CLASSIFICATION_BOUNDARIES) {
    if (!entries.some((entry) => entry?.boundary === boundary)) {
      record(`corpus must distinguish ${boundary}`);
    }
  }

  return [...errors].sort();
}
