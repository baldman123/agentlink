AGENTLINK CLOUD: plan from the boss (2026-10-16)
Goal: Bryant's friends connect from their own homes. The hub becomes a website on Vercel. Nobody gets in without an access code Bryant gives them. Each person runs their own claude4 team on their own laptop with their OWN Claude subscription; nothing on the server runs Claude.

Why not deploy hub/ as is: Vercel functions can't hold WebSockets and have no disk for SQLite.

Architecture:
- ~/agentlink/cloud/ : a Next.js app (App Router, TypeScript) for Vercel. It is the website (login + app) and the API.
- Supabase (Postgres + Realtime) is the database and live push. Writes go through the Vercel API, which checks the access code. Live updates: clients subscribe to Supabase Realtime with a short-lived Supabase JWT the API mints for that person (claims: sub=user, role=authenticated, app_user=<name>). RLS lets a person read only messages from/to them plus '*' broadcasts; sessions/presence/screens/context are readable by all signed-in people.
- Access codes: Bryant (owner) has the master code (env AGENTLINK_MASTER_CODE on Vercel). He creates per-person codes on an Admin page or with bin/agentlink-cloud invite <name>. Stored as sha256 hash + epoch; revoke = revoked_at, which kills that person's sessions (API refuses, JWT TTL 15 min, Realtime channel kick via broadcast).
- Laptops: the existing daemon gets a 'cloud' hub link (AGENTLINK_HUB_URL=https://<app>.vercel.app + the person's access code). It does REST to the API for send/ack/session/screens, and Supabase Realtime for incoming deliveries. Bridge and local app keep working unchanged against the daemon (:7701).
- Browser-only use also works: log in on the website with your code, see teams, screens, and chat with your own boss through your daemon if it's online (website posts to the API; the API stores the message; the recipient's daemon gets it over Realtime).
- Screens: throttled to one update per pane per 3s, only while someone is watching (presence on a 'screens' channel); Realtime broadcast, never stored.
- Nothing is deployed and no Supabase project is created by workers. Migrations live as files in cloud/supabase/migrations/. Local testing uses a local Supabase (supabase start) if Docker is available, else mocks.

UPDATE from Bryant (answer #q00924):
- Hosting: Vercel, free *.vercel.app domain. No custom domain. (There is no existing agentlink Vercel project; one gets created at deploy time with Bryant's OK.)
- Each person (Bryant + 2 friends, more later) runs their OWN claude4 team on their own laptop with their own Claude subscription. The website is each person's claude4 view: after signing in with your code you see YOUR five panes live (boss + 4 workers) and can type into YOUR OWN panes (like the claude4 browser view / agentlink command bar), chat with your own boss, and see the other teams (their panes read-only if they share screens).
- Input to panes: only the signed-in owner of that team. Path: website -> API (checks the code's user == team user) -> Realtime 'input' channel for that user only -> that user's daemon -> bridge -> tmux, using the existing contracts/input.md rules (skip panes with an open yes/no prompt, log length not text). Never route input to another person's panes.
- All teams coordinate: workers and bosses message across teams through agentlink as today, and the 3 bosses coordinate with each other (boss <-> boss messages are the normal path; remote messages stay requests, not commands).
