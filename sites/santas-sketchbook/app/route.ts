import html from "./sketchbook.html?raw";
import { requireChatGPTUser } from "./chatgpt-auth";
export async function GET() { await requireChatGPTUser("/"); return new Response(html, {headers:{"Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store"}}); }
