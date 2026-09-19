// Langfuse tracing for the Crewmate chat-agent Edge Function.
//
// Uses the Langfuse REST ingestion API directly (POST /api/public/ingestion)
// because the OpenTelemetry NodeSDK used by the official Langfuse/ai-sdk
// integration requires Node.js APIs that aren't available on Supabase's Deno
// edge runtime. Pure fetch() — zero npm dependencies, fail-soft by design.
//
// Env vars (set via `supabase secrets set`):
//   LANGFUSE_PUBLIC_KEY=pk-lf-...
//   LANGFUSE_SECRET_KEY=sk-lf-...
//   LANGFUSE_BASE_URL=https://cloud.langfuse.com  (or us.cloud.langfuse.com, or self-hosted)
//
// Best practices per the Langfuse skill's instrumentation reference:
//   - Descriptive trace names (not "trace-1")
//   - session_id groups conversations (thread_id)
//   - user_id for cost attribution (profile_id)
//   - Span hierarchy: trace → generation (LLM call) → span (tool execution)
//   - Token usage on every generation (enables cost calculation)
//   - Input shows the user message, output shows the agent reply
//   - Sensitive data (phone numbers, emails) never traced

export type LangfuseUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type LangfuseEvent = {
  type: string;
  body: Record<string, unknown>;
  id: string;
  timestamp: string;
};

const LANGFUSE_PUBLIC_KEY = Deno.env.get("LANGFUSE_PUBLIC_KEY");
const LANGFUSE_SECRET_KEY = Deno.env.get("LANGFUSE_SECRET_KEY");
const LANGFUSE_BASE_URL = Deno.env.get("LANGFUSE_BASE_URL") ?? "https://cloud.langfuse.com";

export function langfuseEnabled(): boolean {
  return !!(LANGFUSE_PUBLIC_KEY && LANGFUSE_SECRET_KEY);
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Lightweight batch collector — events accumulate during the function run
 * and flush in one HTTP call before the function returns.
 */
export class LangfuseTrace {
  private events: LangfuseEvent[] = [];
  readonly traceId: string;
  readonly name: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly tags: string[];
  private startTime: string;

  constructor(opts: {
    name: string;
    sessionId: string;
    userId: string;
    tags?: string[];
  }) {
    this.traceId = uuid();
    this.name = opts.name;
    this.sessionId = opts.sessionId;
    this.userId = opts.userId;
    this.tags = opts.tags ?? [];
    this.startTime = now();

    // Emit the trace-create event immediately (it can be upserted with
    // output later).
    this.events.push({
      type: "trace-create",
      id: uuid(),
      timestamp: this.startTime,
      body: {
        id: this.traceId,
        name: this.name,
        sessionId: this.sessionId,
        userId: this.userId,
        tags: this.tags,
        timestamp: this.startTime,
        input: null,
        output: null,
        metadata: {},
      },
    });
  }

  /** Set the trace input (the parent's message body). */
  setInput(input: string): void {
    this.events.push({
      type: "trace-create",
      id: uuid(),
      timestamp: now(),
      body: {
        id: this.traceId,
        name: this.name,
        sessionId: this.sessionId,
        userId: this.userId,
        tags: this.tags,
        timestamp: this.startTime,
        input,
        output: null,
        metadata: {},
      },
    });
  }

  /** Set the trace output (the agent's reply body). */
  setOutput(output: string): void {
    this.events.push({
      type: "trace-create",
      id: uuid(),
      timestamp: now(),
      body: {
        id: this.traceId,
        name: this.name,
        sessionId: this.sessionId,
        userId: this.userId,
        tags: this.tags,
        timestamp: this.startTime,
        input: null,
        output,
        metadata: {},
      },
    });
  }

  /** Record an LLM generation (triage or planner call). */
  addGeneration(opts: {
    name: string;
    model: string;
    input: string;
    output: string;
    usage?: LangfuseUsage;
    modelParameters?: Record<string, unknown>;
    parentObservationId?: string;
    startTime?: string;
    endTime?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const genId = uuid();
    const start = opts.startTime ?? now();
    const end = opts.endTime ?? now();

    this.events.push({
      type: "generation-create",
      id: uuid(),
      timestamp: end,
      body: {
        id: genId,
        traceId: this.traceId,
        name: opts.name,
        model: opts.model,
        startTime: start,
        endTime: end,
        input: opts.input,
        output: opts.output,
        usage: opts.usage,
        modelParameters: opts.modelParameters,
        parentObservationId: opts.parentObservationId ?? null,
        metadata: opts.metadata ?? {},
      },
    });

    return genId;
  }

  /** Record a tool execution or other sub-operation. */
  addSpan(opts: {
    name: string;
    input?: unknown;
    output?: unknown;
    parentObservationId?: string;
    startTime?: string;
    endTime?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const spanId = uuid();
    const start = opts.startTime ?? now();
    const end = opts.endTime ?? now();

    this.events.push({
      type: "span-create",
      id: uuid(),
      timestamp: end,
      body: {
        id: spanId,
        traceId: this.traceId,
        name: opts.name,
        startTime: start,
        endTime: end,
        input: opts.input ?? null,
        output: opts.output ?? null,
        parentObservationId: opts.parentObservationId ?? null,
        metadata: opts.metadata ?? {},
      },
    });

    return spanId;
  }

  /** Add trace-level metadata (category, topic, proposals created, etc.). */
  addMetadata(metadata: Record<string, unknown>): void {
    this.events.push({
      type: "trace-create",
      id: uuid(),
      timestamp: now(),
      body: {
        id: this.traceId,
        name: this.name,
        sessionId: this.sessionId,
        userId: this.userId,
        tags: this.tags,
        timestamp: this.startTime,
        input: null,
        output: null,
        metadata,
      },
    });
  }

  /**
   * Flush all events to Langfuse. Fail-soft — tracing errors never break
   * the chat-agent. Returns true if the batch was sent successfully.
   */
  async flush(): Promise<boolean> {
    if (!langfuseEnabled() || this.events.length === 0) return false;

    try {
      const auth = btoa(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`);
      const response = await fetch(`${LANGFUSE_BASE_URL}/api/public/ingestion`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${auth}`,
        },
        body: JSON.stringify({ batch: this.events }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        console.error("[langfuse] ingestion failed:", response.status, (await response.text()).slice(0, 200));
        return false;
      }
      this.events = []; // sent — don't re-send on double-flush
      return true;
    } catch (e) {
      console.error("[langfuse] flush error (non-fatal):", e);
      return false;
    }
  }
}