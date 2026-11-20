import {
  buildOjCapabilities,
  defaultCapabilityRisk,
  ojProviderHealthSchema,
  ojSearchResultSchema,
  type OjCapabilities,
  type OjCapability,
  type OjCapabilityName,
  type OjProblemDocument,
  type OjProviderHealth,
  type OjSearchResult,
  type OjSourceRef
} from "@kaiserunix/oj-mcp-contracts";
import { MonotonicHealthStore, SingleFlightCoalescer } from "@kaiserunix/oj-mcp-server-common";
import { z } from "zod";
import {
  AtCoderClientError,
  AtCoderHtmlClient,
  parseAtCoderTaskUrl,
  type AtCoderLocale,
  type AtCoderTaskLocator
} from "./client.js";
import { parseAtCoderProblem } from "./normalizer.js";

const canonicalIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const localeSchema = z.enum(["en", "ja"]);
const canonicalTaskUrlSchema = z
  .string()
  .url()
  .max(300)
  .regex(/^https:\/\/atcoder\.jp\/contests\/[a-z0-9][a-z0-9_-]{0,63}\/tasks\/[a-z0-9][a-z0-9_-]{0,63}(?:\?lang=(?:en|ja))?$/)
  .describe("Canonical HTTPS atcoder.jp task URL, optionally with one en/ja lang query.");

export const atCoderFetchProblemInputSchema = z.union([
  z
    .object({
      url: canonicalTaskUrlSchema,
      locale: localeSchema.optional().describe("Statement locale. Overrides the URL lang query when supplied.")
    })
    .strict(),
  z
    .object({
      contestId: canonicalIdSchema.describe("Exact AtCoder contest id, such as abc086."),
      taskId: canonicalIdSchema.describe("Exact AtCoder task id, such as abc086_a."),
      locale: localeSchema.optional().describe("Statement locale. Defaults to English.")
    })
    .strict()
]);

export const atCoderSearchInputSchema = z
  .object({
    schemaVersion: z.literal("oj.search-request/v1"),
    requestId: z.string().min(1).max(200),
    platform: z.literal("atcoder"),
    query: z.string().trim().min(1).max(300),
    locale: localeSchema.optional(),
    limit: z.number().int().min(1).max(50)
  })
  .strict();

export type AtCoderFetchProblemInput = z.infer<typeof atCoderFetchProblemInputSchema>;

export interface AtCoderProviderOptions {
  client?: AtCoderHtmlClient;
  now?: () => number;
  nowIso?: () => string;
}

export class AtCoderProvider {
  private readonly client: AtCoderHtmlClient;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private readonly healthStore = new MonotonicHealthStore<AtCoderClientError>();
  private readonly singleFlight = new SingleFlightCoalescer<OjProblemDocument>();

  constructor(options: AtCoderProviderOptions = {}) {
    this.client = options.client ?? new AtCoderHtmlClient();
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  async fetchProblem(input: unknown, signal?: AbortSignal): Promise<OjProblemDocument> {
    let locator: AtCoderTaskLocator;
    try {
      const parsed = atCoderFetchProblemInputSchema.parse(input);
      locator = resolveLocator(parsed);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof TypeError) {
        throw new AtCoderClientError(
          "request.invalid",
          error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(" ") : error.message
        );
      }
      throw error;
    }

    const key = `${locator.contestId}/${locator.taskId}?lang=${locator.locale}`;
    return this.singleFlight.run(
      key,
      (upstreamSignal) => this.loadProblem(locator, upstreamSignal, this.healthStore.begin()),
      {
        signal,
        createCancelledError: cancelledRead,
        abortMessage: "All AtCoder read consumers cancelled."
      }
    );
  }

  private async loadProblem(locator: AtCoderTaskLocator, signal: AbortSignal, sequence: number): Promise<OjProblemDocument> {
    const startedAt = this.now();
    try {
      const page = await this.client.fetchTask(locator, signal);
      const fetchedAt = this.nowIso();
      const document = await parseAtCoderProblem(page, { fetchedAt, adapterVersion: "0.1.0" });
      if (!signal.aborted) {
        this.healthStore.recordSuccess(sequence, fetchedAt, this.now() - startedAt);
      }
      return document;
    } catch (error) {
      const mapped =
        error instanceof z.ZodError
          ? new AtCoderClientError("upstream.schema_changed", "Normalized AtCoder content failed the shared problem schema.")
          : error;
      if (
        mapped instanceof AtCoderClientError &&
        !signal.aborted &&
        mapped.code !== "resource.not_found" &&
        mapped.code !== "request.invalid" &&
        mapped.transportCause !== "consumer_cancelled"
      ) {
        this.healthStore.recordError(sequence, this.nowIso(), mapped, this.now() - startedAt);
      }
      throw mapped;
    }
  }

  async getCapabilities(transport: OjCapability["transport"]): Promise<OjCapabilities> {
    const checkedAt = this.nowIso();
    return buildOjCapabilities({
      providerId: "atcoder-page-adapter",
      providerVersion: "0.1.0",
      platform: "atcoder",
      source: providerSource(checkedAt),
      buildOperation: (name) => capability(name, checkedAt, transport)
    });
  }

  async search(input: unknown, signal?: AbortSignal): Promise<OjSearchResult> {
    let request: z.infer<typeof atCoderSearchInputSchema>;
    let locator: AtCoderTaskLocator;
    try {
      request = atCoderSearchInputSchema.parse(input);
      const locale = request.locale;
      locator = exactSearchLocator(request.query, locale);
    } catch (error) {
      if (error instanceof AtCoderClientError) throw error;
      if (error instanceof z.ZodError || error instanceof TypeError) {
        throw new AtCoderClientError(
          "request.invalid",
          error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(" ") : error.message
        );
      }
      throw error;
    }

    try {
      const document = await this.fetchProblem(locator, signal);
      return ojSearchResultSchema.parse({
        schemaVersion: "oj.search-result/v1",
        requestId: request.requestId,
        items: [
          {
            schemaVersion: "oj.problem-summary/v1",
            ref: document.ref,
            title: document.title,
            tags: document.tags,
            contestLabel: locator.contestId,
            source: document.source
          }
        ],
        source: document.source
      });
    } catch (error) {
      if (!(error instanceof AtCoderClientError) || error.code !== "resource.not_found") throw error;
      return ojSearchResultSchema.parse({
        schemaVersion: "oj.search-result/v1",
        requestId: request.requestId,
        items: [],
        source: taskSource(locator, this.nowIso())
      });
    }
  }

  async getHealth(): Promise<OjProviderHealth> {
    const observation = this.healthStore.snapshot();
    if (observation?.error) return errorHealth(observation.error, observation.latencyMs ?? 0, this.nowIso());
    return ojProviderHealthSchema.parse({
      schemaVersion: "oj.provider-health/v1",
      providerId: "atcoder-page-adapter",
      platform: "atcoder",
      checkedAt: this.nowIso(),
      overall: "healthy",
      layers: {
        transport: "pass",
        protocol: "pass",
        schema: observation ? "pass" : "unknown",
        auth: "not_required",
        upstream: "pass"
      },
      ...(observation?.latencyMs !== undefined ? { latencyMs: observation.latencyMs } : {}),
      message: observation
        ? "The latest anonymous AtCoder task read passed transport, HTML, and shared-schema validation."
        : "AtCoder adapter is ready; upstream not yet observed in this process."
    });
  }
}

function resolveLocator(input: AtCoderFetchProblemInput): AtCoderTaskLocator {
  if ("url" in input) return parseAtCoderTaskUrl(input.url, input.locale);
  return {
    contestId: input.contestId!,
    taskId: input.taskId!,
    locale: (input.locale ?? "en") as AtCoderLocale
  };
}

function cancelledRead(): AtCoderClientError {
  return new AtCoderClientError(
    "network.timeout",
    "The AtCoder read was cancelled.",
    undefined,
    undefined,
    "consumer_cancelled"
  );
}

function exactSearchLocator(query: string, locale?: AtCoderLocale): AtCoderTaskLocator {
  const trimmed = query.trim();
  if (/^https:/i.test(trimmed)) return parseAtCoderTaskUrl(trimmed, locale);
  const nativeId = trimmed.startsWith("atcoder:") ? trimmed.slice("atcoder:".length) : trimmed;
  const match = /^([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(nativeId);
  if (!match) {
    throw new TypeError("AtCoder search accepts only an exact contest/task id, atcoder:contest/task id, or canonical task URL.");
  }
  return { contestId: match[1]!, taskId: match[2]!, locale: locale ?? "en" };
}

function capability(name: OjCapabilityName, checkedAt: string, transport: OjCapability["transport"]): OjCapability {
  if (name === "searchProblems" || name === "fetchProblem") {
    return {
      name,
      status: "available",
      toolName: name === "searchProblems" ? "oj_search_problems" : "oj_fetch_problem",
      transport,
      auth: "none",
      risk: "R0_public_read",
      compliance: "unofficial",
      reason:
        name === "searchProblems"
          ? "Exact contest/task lookup only; this adapter does not crawl AtCoder's problem catalog."
          : "Reads public statement HTML from the official atcoder.jp task page without authentication.",
      checkedAt
    };
  }
  return {
    name,
    status: "unsupported",
    transport,
    auth: "none",
    risk: defaultCapabilityRisk(name),
    compliance: "unofficial",
    reason: "This anonymous AtCoder page adapter exposes public problem reads only.",
    checkedAt
  };
}

function providerSource(fetchedAt: string): OjSourceRef {
  return {
    kind: "page_adapter",
    adapterId: "atcoder-page-adapter",
    adapterVersion: "0.1.0",
    fetchedAt,
    sourceUrl: "https://atcoder.jp/",
    confidence: "derived"
  };
}

function taskSource(locator: AtCoderTaskLocator, fetchedAt: string): OjSourceRef {
  return {
    kind: "page_adapter",
    adapterId: "atcoder-page-adapter",
    adapterVersion: "0.1.0",
    fetchedAt,
    sourceUrl: `https://atcoder.jp/contests/${locator.contestId}/tasks/${locator.taskId}?lang=${locator.locale}`,
    confidence: "derived"
  };
}

function errorHealth(error: AtCoderClientError, latencyMs: number, checkedAt: string): OjProviderHealth {
  const notFound = error.code === "resource.not_found";
  const upstream: OjProviderHealth["layers"]["upstream"] =
    error.code === "rate_limited"
      ? "rate_limited"
      : error.code === "network.timeout"
        ? "timeout"
        : error.code === "challenge.required" || error.code === "policy.blocked"
          ? "blocked"
          : notFound
            ? "pass"
            : "fail";
  return ojProviderHealthSchema.parse({
    schemaVersion: "oj.provider-health/v1",
    providerId: "atcoder-page-adapter",
    platform: "atcoder",
    checkedAt,
    overall: notFound ? "healthy" : error.code === "upstream.unavailable" ? "unavailable" : "degraded",
    layers: {
      transport: error.code === "network.timeout" ? "fail" : "pass",
      protocol: "pass",
      schema: error.code === "upstream.schema_changed" ? "drift" : "unknown",
      auth: "not_required",
      upstream
    },
    latencyMs,
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    message: notFound
      ? "The latest exact AtCoder task lookup returned a normal not-found response."
      : `The latest anonymous AtCoder task read failed: ${error.message}`
  });
}
