import * as Sentry from "@sentry/react";

function detectEnvironment(): "development" | "staging" | "production" {
  if (import.meta.env.DEV) return "development";
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
  if (supabaseUrl.includes("jfyjgmhqnlbdcafoarrg")) return "staging";
  return "production";
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\b(\+?\d{1,2}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const TESTAUTH_RE = /testAuth=[^&]+/g;

function scrubString(value: string): string {
  return value
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, "[redacted-phone]")
    .replace(TESTAUTH_RE, "testAuth=[redacted]");
}

function scrubBreadcrumbs(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (!event.breadcrumbs) return event;
  return {
    ...event,
    breadcrumbs: event.breadcrumbs.map((crumb) => {
      if (crumb.data) {
        const next: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(crumb.data)) {
          next[k] = typeof v === "string" ? scrubString(v) : v;
        }
        return { ...crumb, data: next };
      }
      return crumb;
    }),
  };
}

const IGNORED_ERRORS = [
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications",
  "Non-Error promise rejection captured with value",
];

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) {
    console.info("[sentry] VITE_SENTRY_DSN not set; error monitoring disabled.");
    return;
  }

  Sentry.init({
    dsn,
    environment: detectEnvironment(),
    sampleRate: 1.0,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
      if (event.exception) {
        const values = event.exception.values ?? [];
        for (const v of values) {
          if (v.value && IGNORED_ERRORS.some((p) => v.value!.includes(p))) {
            return null;
          }
          if (v.value) v.value = scrubString(v.value);
        }
      }
      if (event.message) event.message = scrubString(event.message);
      return scrubBreadcrumbs(event);
    },
  });
}