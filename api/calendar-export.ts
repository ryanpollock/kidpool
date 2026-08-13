export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  let content: string | null = null;
  let filename = "carpool-crew-drives.ics";

  if (req.method === "GET") {
    const url = new URL(req.url);
    content = url.searchParams.get("content");
    filename = url.searchParams.get("filename") || filename;
  } else if (req.method === "POST") {
    const body = await req.text();
    const params = new URLSearchParams(body);
    content = params.get("content");
    filename = params.get("filename") || filename;
  } else {
    return new Response("Method not allowed", { status: 405 });
  }

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