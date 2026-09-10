import { lookup } from "node:dns/promises";
import { Buffer } from "node:buffer";

export function publicIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (
    parts.length !== 4 ||
    parts.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)
  )
    return false;
  const [a, b, c] = parts.map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function safeUrl(value: string): URL {
  const u = new URL(value);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.port ||
    u.hostname.includes(":") ||
    u.hostname === "localhost" ||
    u.hostname.endsWith(".localhost") ||
    !u.hostname.includes(".")
  )
    throw new Error("Unsupported URL");
  return u;
}
export async function fetchPublic(
  value: string,
  limit = 512_000,
  redirects = 0,
): Promise<{ bytes: Buffer; type: string; url: string }> {
  if (redirects > 3) throw new Error("Too many redirects");
  const url = safeUrl(value);
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, family: 4 }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("DNS timeout")), 2500),
    ),
  ]);
  if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
    throw new Error("Non-public address");
  const { request, Agent } = await import("npm:undici@6.21.3");
  let pinned = false;
  const dispatcher = new Agent({
    connect: {
      lookup: (_host, options, cb) => {
        pinned = true;
        if (options.all) cb(null, [addresses[0]]);
        else cb(null, addresses[0].address, 4);
      },
    },
  });
  let result: {
    bytes: Buffer;
    type: string;
    status: number;
    location?: string;
  };
  try {
    const response = await request(url, {
      dispatcher,
      maxRedirections: 0,
      signal: AbortSignal.timeout(5000),
      headers: {
        "User-Agent": "CarpoolCrew-LinkPreview/1.0",
        "Accept-Encoding": "identity",
      },
    });
    if (!pinned) throw new Error("Unpinned connection");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error("Response too large");
      chunks.push(Buffer.from(chunk));
    }
    result = {
      bytes: Buffer.concat(chunks),
      type: String(response.headers["content-type"] ?? ""),
      status: response.statusCode,
      location:
        response.statusCode >= 300 && response.statusCode < 400
          ? String(response.headers.location ?? "")
          : undefined,
    };
  } finally {
    await dispatcher.close();
  }
  if (result.location)
    return fetchPublic(
      new URL(result.location, url).href,
      limit,
      redirects + 1,
    );
  if (result.status !== 200) throw new Error("Invalid redirect");
  return { ...result, url: url.href };
}
function decode(value: string): string {
  const names: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };
  return value
    .replace(
      /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
      (_, s: string) => {
        if (s[0] !== "#") return names[s.toLowerCase()] ?? "";
        const n =
          s[1].toLowerCase() === "x"
            ? parseInt(s.slice(2), 16)
            : parseInt(s.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
      },
    )
    .replace(/\s+/g, " ")
    .trim();
}
export function metadata(html: string): {
  title: string;
  description: string;
  image: string;
} {
  const values: Record<string, string> = {};
  for (const tag of html.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(
      /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    ))
      attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4]);
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (key && attrs.content && !values[key]) values[key] = attrs.content;
  }
  return {
    title: (
      values["og:title"] ||
      values["twitter:title"] ||
      decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    ).slice(0, 200),
    description: (
      values["og:description"] ||
      values.description ||
      values["twitter:description"] ||
      ""
    ).slice(0, 400),
    image: values["og:image"] || values["twitter:image"] || "",
  };
}
export function imageData(bytes: Buffer): string | null {
  let type = "";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    type = "image/png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    type = "image/jpeg";
  else if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    type = "image/webp";
  return type ? `data:${type};base64,${bytes.toString("base64")}` : null;
}
