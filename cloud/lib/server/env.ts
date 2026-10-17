// Server configuration (contracts/cloud-api.md "Server env"). Read lazily so a missing variable fails the request
// that needs it with a clear message, not the whole build.

export interface CloudEnv {
  owner: string;
  masterCode: string;
  sessionSecret: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceKey: string;
  supabaseJwtSecret: string;
  hubName: string;
  filesBucket?: string; // AGENTLINK_FILES_BUCKET: private Storage bucket for files (uploads.md "Website")
  cronSecret?: string | null; // CRON_SECRET: lets Vercel Cron call /api/files/cleanup
}

export class ConfigError extends Error {}

const USER_RE = /^[a-z0-9_-]{1,32}$/;

export function readEnv(e: NodeJS.ProcessEnv = process.env): CloudEnv {
  const need = (k: string) => {
    const v = e[k];
    if (!v) throw new ConfigError(`${k} is not set`);
    return v;
  };
  const owner = need("AGENTLINK_OWNER");
  if (!USER_RE.test(owner)) throw new ConfigError("AGENTLINK_OWNER must be a lowercase user name ([a-z0-9_-]{1,32})");
  const masterCode = need("AGENTLINK_MASTER_CODE");
  if (masterCode.length < 16) throw new ConfigError("AGENTLINK_MASTER_CODE must be at least 16 characters");
  const sessionSecret = need("AGENTLINK_SESSION_SECRET");
  if (sessionSecret.length < 32) throw new ConfigError("AGENTLINK_SESSION_SECRET must be at least 32 characters");
  return {
    owner,
    masterCode,
    sessionSecret,
    supabaseUrl: need("SUPABASE_URL").replace(/\/+$/, ""),
    supabaseAnonKey: need("SUPABASE_ANON_KEY"),
    supabaseServiceKey: need("SUPABASE_SERVICE_ROLE_KEY"),
    supabaseJwtSecret: need("SUPABASE_JWT_SECRET"),
    hubName: e.AGENTLINK_HUB_NAME || "agentlink-cloud",
    filesBucket: e.AGENTLINK_FILES_BUCKET || "agentlink-files",
    cronSecret: e.CRON_SECRET && e.CRON_SECRET.length >= 16 ? e.CRON_SECRET : null,
  };
}
