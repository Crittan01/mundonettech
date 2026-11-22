import { connection } from "next/server";

const headers = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

export async function GET() {
  await connection();
  return Response.json({ status: "alive" }, { headers });
}
