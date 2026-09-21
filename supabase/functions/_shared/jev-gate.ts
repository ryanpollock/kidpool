// Jev invocation gate — Crewmate's always-on listener.
//
// Uses the TypeSafe AI REST API directly (POST /v1/systemone, verified
// format from docs.typesafe.ai). Pure fetch() — zero npm dependencies,
// Deno-compatible, fail-soft by design.
//
// Replaces the GLM triage classifier (~1300 tokens/message) with a single
// Jev call (~330 tokens input, output free, ~100ms). Jev evaluates every
// untagged message in group threads and decides if Crewmate should respond:
//   - Noul: "Is this parent asking Crewmate for help?"
//   - Choice: "What type of message is this?" (question/action/consent/chatter)
//
// Env var: TYPESAFE_API_KEY (set via `supabase secrets set`)
// API endpoint: https://api.typesafe.ai/v1/systemone
// Auth: Authorization: Bearer <key>
//
// Noul responses return a FLOAT (0.0–1.0 = probability that the answer
// is yes), not a boolean. Threshold for "yes" is >= 0.5.

const TYPESAFE_API_KEY = Deno.env.get("TYPESAFE_API_KEY");
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

export function jevEnabled(): boolean {
  return !!TYPESAFE_API_KEY;
}

export type JevGateResult = {
  helpRequested: number; // P(yes) from the Noul question (0.0–1.0)
  messageType: "question" | "action" | "consent" | "chatter";
  messageConfidence: number; // Choice confidence (0.0–1.0)
  inputTokens: number;
  outputTokens: number;
};

export type JevConsentResult = {
  affirmative: boolean; // true if P(yes) >= 0.5
  confidence: number; // the P(yes) value from Noul
  inputTokens: number;
  outputTokens: number;
};

/**
 * Evaluate an untagged group-thread message through Jev's gate.
 * Sends two questions in one call (speculative fan-out):
 *   1. Noul: "Is this parent asking Crewmate for help with the schedule?"
 *   2. Choice: "What type of message is this?"
 *
 * Returns null on failure — caller falls back to tag-only behavior.
 */
export async function jevGate(opts: {
  state: string; // parent's message + recent thread context
}): Promise<JevGateResult | null> {
  if (!jevEnabled()) return null;

  try {
    const response = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: opts.state,
        model: "jev-latest",
        questions: {
          help_requested: {
            type: "noul",
            instructions:
              "Is this parent asking Crewmate AI for help with the carpool schedule? " +
              "A question about who drives, coverage, pickup times, or a request to change the schedule counts as yes. " +
              "Social chat, small talk, kid TV shows, birthdays, sports, traffic, or messages directed at other parents are no.",
          },
          message_type: {
            type: "choice",
            instructions: "What kind of message is this?",
            criteria: {
              question: "Asking about the schedule, rosters, coverage, times, who drives/rides, or the weekly cycle",
              action: "Requesting a schedule change (cancel a ride, switch cars, volunteer, add a drive, change seat count)",
              consent: "Confirming or declining a pending proposal card (e.g. 'yes, go ahead' or 'confirmed')",
              chatter: "Social conversation, small talk, anything not about the carpool schedule",
            },
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error("[jev-gate] API error:", response.status, (await response.text()).slice(0, 200));
      return null;
    }

    const data = await response.json();
    const help = data.answers?.help_requested;
    const msgType = data.answers?.message_type;

    if (!help || !msgType) {
      console.error("[jev-gate] unexpected response shape:", JSON.stringify(data).slice(0, 200));
      return null;
    }

    const validTypes = ["question", "action", "consent", "chatter"];
    const type = validTypes.includes(msgType.choice) ? msgType.choice : "question";

    return {
      helpRequested: help.noul ?? 0,
      messageType: type,
      messageConfidence: msgType.confidence ?? 0,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  } catch (e) {
    console.error("[jev-gate] fetch error (non-fatal):", e);
    return null;
  }
}

/**
 * Check if a message is an affirmative confirmation of a pending proposal.
 * Used when the Jev gate identifies a consent message (or a pending
 * proposal exists for the sender). Replaces the LLM consent classifier.
 *
 * Returns null on failure — caller falls through to the planner.
 */
export async function jevConsent(opts: {
  messageBody: string;
  proposalSummary: string;
}): Promise<JevConsentResult | null> {
  if (!jevEnabled()) return null;

  try {
    const response = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: `The parent says: "${opts.messageBody}". The pending proposal card says: "${opts.proposalSummary}".`,
        model: "jev-latest",
        questions: {
          is_affirmative: {
            type: "noul",
            instructions:
              "Is this message an affirmative confirmation of the pending proposal card? " +
              "Only clear yes/ok/confirmed/go-ahead messages are yes. " +
              "Declines, hesitations, topic changes, or questions are no.",
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error("[jev-consent] API error:", response.status);
      return null;
    }

    const data = await response.json();
    const answer = data.answers?.is_affirmative;

    if (!answer || typeof answer.noul !== "number") {
      console.error("[jev-consent] unexpected response:", JSON.stringify(data).slice(0, 200));
      return null;
    }

    return {
      affirmative: answer.noul >= 0.5,
      confidence: answer.noul,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  } catch (e) {
    console.error("[jev-consent] fetch error (non-fatal):", e);
    return null;
  }
}