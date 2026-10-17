// Browser side of "Your calls" (contracts/calls.ts): the yes/no decisions the boss passes to you.
import type { Call, CallChoice, CallListResponse } from "../../../contracts/calls.ts";
import { api } from "./api.ts";

export type { Call, CallChoice };

export const listCalls = () => api<CallListResponse>("/api/calls");
/** Yes or No (note optional), or for a question just the note: a free-text answer (choice null). */
export const answerCall = (id: string, choice: CallChoice | null, note: string) =>
  api<{ call: Call }>(`/api/calls/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    json: { ...(choice ? { choice } : {}), ...(note ? { note } : {}) },
  });
