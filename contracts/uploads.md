# Files (uploads)

Added 2026-10-17 on top of protocol v2, without a version bump: the new fields and routes are additive. A hub without them answers `404` on
`/api/files/*`, and the sender's daemon drops the message with a note saying the hub is too old to relay files. Types and limits are in
`contracts/uploads.ts`.

## Where files land

Every file ends up on the laptop of the agent that reads it, at `<uploads>/<YYYY-MM-DD>/<name>`. `<uploads>` is `AGENTLINK_UPLOADS_DIR`,
default `<folder of the daemon db>/uploads`, which is `data/uploads/` under `scripts/team-up.sh`. The date is the laptop's local date.

Names go through `sanitizeFileName`: only the last path part, no control, bidi or zero-width characters, none of `< > : " / \ | ? *`,
`[` and `]` become `(` and `)`, no leading dots, never `.` or `..`, at most 150 UTF-8 bytes, extension kept. A name already taken that day
becomes `name-2.ext`, `name-3.ext`; nothing is ever overwritten (a hard link claims the name atomically). Files are written `0600`.

## Limits

| What | Limit | Error |
|---|---|---|
| One file to this laptop's own agents or panes | `UPLOAD_MAX_LOCAL_BYTES` = 2 GB | `413 file_too_large` from `POST /v1/uploads` (checked on `Content-Length` before reading, and while streaming) |
| One file that crosses the hub (another person, `user/*` of someone else, or `*`) | `UPLOAD_MAX_HUB_BYTES` = 200 MB | `413 file_too_large` from `POST /v1/send`, and from the hub's `PUT /api/files/:id` |
| Files per message | `ATTACHMENTS_MAX` = 20 | `400 bad_attachments` |

## Daemon API

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/v1/uploads?name=<file name>&mime=<type>` | the raw bytes (`Content-Type: application/octet-stream`), streamed | `201 UploadResult {id, name, size, sha256, mime?, path, created_at}`. `400 bad_name`, `400 incomplete_upload` (fewer bytes than `Content-Length`), `413 file_too_large` |
| GET | `/v1/uploads/:id` | | `UploadResult`, or 404 |
| DELETE | `/v1/uploads/:id` | | 204; deletes the file (the composer's ✕ before sending) |
| POST | `/v1/send` | `SendRequest` plus `attachments: [upload id, …]` | as before. The daemon puts the files in `body.attachments` (a string body becomes `{text, attachments}`). `404 unknown_upload`, `413 file_too_large`, `501 uploads_need_storage` (cloud mode, another person) |

The same origin rules apply as for every daemon route (loopback Host, local or UI Origin). `Content-Type: application/octet-stream` makes a
browser preflight the request, so another web page can't upload without the daemon's CORS answer.

## In the envelope

`RichBody.attachments: Attachment[]`, each `{id, name, size, sha256, mime?, path?, error?}`.

- `id` is the uuid the first daemon gave the file. It stays the same on every laptop, so a redelivered message doesn't download twice.
- `path` is only ever the reading laptop's own path. For a message to another person the sending daemon leaves it out; the receiving daemon
  drops any `path` it finds, downloads the file, checks size and sha256, and sets its own. For the sender's own agents `path` is the local file.
- `error` replaces `path` when a file couldn't be had (gone from the hub, checksum mismatch, the website relays no files yet).

## LAN hub

Both directions use the REST session from the daemon's socket (`Authorization: Bearer <session>`, hub-api.md "Auth"). Only `daemon` sessions
may use these routes (`403 daemon_only` for a UI session).

| Method | Path | Result |
|---|---|---|
| PUT | `/api/files/:id` | Body: the bytes. Headers: `Content-Length` (required), `X-Agentlink-Sha256`, `X-Agentlink-To` (the envelope's `to`), `X-Agentlink-Name` (URI-encoded), `X-Agentlink-Mime`. `201`, or `200` when this uploader already sent the same id and sha256. `409 id_taken`, `411`, `413 file_too_large`, `400 incomplete_upload` (size or sha256 differ) |
| GET | `/api/files/:id` | The bytes with `Content-Length` and `X-Agentlink-Sha256`. Readable by the uploader, the user of `to`, and everyone when `to` is `*`. Anyone else gets `404`, the same as a missing file |

Order on the sending daemon: an outbox item with files for another user waits until every file is on the current hub (remembered per hub id
and file id), then goes out as usual. A refusal that won't change (`4xx` other than 401) drops the message and puts a `status` note in the
sender's inbox; a network error or `5xx` retries with the outbox backoff.

Order on the receiving daemon: a `deliver` with files is stored and acked only after its files are downloaded (up to 3 tries each). If the
socket drops meanwhile, nothing is acked and the hub delivers it again after the reconnect. So the bridge never pastes a path that isn't there.

The hub keeps each file as `<hub data>/hub-files/<id>` plus `<id>.json`, and deletes both after `HUB_FILE_TTL_MS` (7 days).

## What the pane gets

The bridge adds one line per file after the message text: `[attached: /full/path]`, or
`[attachment not available: <name> (<why>)]`. For a remote sender these lines are inside the same untrusted fence as the rest of the message
(the names are theirs). Claude Code reads images and PDFs by path and opens other types with its tools.

The command bar (input.md) types the same lines into its own panes, after the typed text on one line.

## Website (cloud mode)

Not relayed yet. A file needs somewhere to live between two laptops, and the website has no file storage. Until there is:

- the website's composers show "File uploads through the website need storage set up; see SETUP.md";
- a daemon in cloud mode refuses `POST /v1/send` with files for another person: `501 uploads_need_storage`, same text;
- files to the person's own agents work in cloud mode too (they never leave the laptop), from the local app at `http://127.0.0.1:7780`;
- a delivered message that names a file this laptop doesn't have shows `[attachment not available: … (file uploads through the website need storage set up; see SETUP.md)]`.

SETUP.md, "Files through the website", lists what the website needs.
