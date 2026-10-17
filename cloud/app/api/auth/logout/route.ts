import { isHttps, json, route } from "../../../../lib/server/http.ts";
import { sessionCookie } from "../../../../lib/server/logic.ts";

export const POST = route(async (req) => json(204, undefined, { "set-cookie": sessionCookie("", isHttps(req), 0) }));
