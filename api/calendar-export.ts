export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const body = await req.text();
  const params = new URLSearchParams(body);
  const content = params.get("content");
  const filename = params.get("filename") || "carpool-crew-drives.ics";
  if (!content) {
    return new Response("Missing content", { status: 400 });
  }
  if (content.length > 50000) {
    return new Response("Content too large", { status: 413 });
  }
  return new Response(content, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}