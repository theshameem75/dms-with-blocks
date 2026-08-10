# Vault — document management on SELISE Blocks

A frontend-only Google Drive/OneDrive-style app on Next.js. Blocks provides everything
behind the scenes — SSO/OIDC login, user identity, and file storage (DMS). This repo
adds no custom backend beyond what's needed to broker the OIDC handshake.

## Architecture

- **All OIDC with Blocks happens in the Next.js backend** (Route Handlers under
  `src/app/api/auth/*`), never in the browser:
  - `GET /api/auth/login` — asks Blocks for the hosted-login authorize URL and redirects
    the browser to it.
  - `GET /api/auth/callback` — receives the authorization code, exchanges it for a Blocks
    session **server-to-server**, and mints a bearer access token.
  - `GET /api/auth/session` — the frontend calls this on load to get a currently-valid
    bearer token.
  - `POST /api/auth/refresh` — mints a new bearer token after a 401 from Blocks.
  - `POST /api/auth/logout` — revokes the Blocks session and clears this app's own
    session cookie.
  - The Blocks session/refresh cookies never reach the browser. They're held
    server-side in this app's own httpOnly session cookie (`src/lib/session.ts`,
    `src/lib/blocks-oidc.ts`) and used only to mint short-lived access tokens.
- **The frontend talks to Blocks services directly**, attaching the bearer token as
  `Authorization: Bearer <token>` (`src/lib/blocks/http.ts`). No other backend, no
  proxying of Blocks calls through Next — file upload/download, folder browsing, and
  the current-user profile all hit Blocks straight from the browser.
  - IAM (`/iam/v4/*`) goes to this project's dedicated dev gateway,
    `https://blocksapi.dev.slsblx.com`, not the shared `api.seliseblocks.com`.
  - Storage/DMS (`/Files/*`, `/Directory/*`, `/Content/*`) switches host **and** base
    path together via `NEXT_PUBLIC_BLOCKS_STORAGE_MODE` (`src/lib/blocks/config.ts`):
    `"local"` (default) hits a standalone instance at `NEXT_PUBLIC_BLOCKS_STORAGE_API_URL`
    (default `http://localhost:9000`) under `/api`
    (`http://localhost:9000/api/Directory/GetDirectoryChildren`); `"live"` hits the main
    gateway (`NEXT_PUBLIC_BLOCKS_API_URL`) under `/data/v4`
    (`https://blocksapi.dev.slsblx.com/data/v4/Directory/GetDirectoryChildren`). See
    `blocksFilesFetch` in `src/lib/blocks/http.ts`.
- **User activation** (`/activate`) is a direct, unauthenticated call to Blocks
  (`POST /iam/v4/auth/activate`) for the invite-and-activate flow — no bearer token
  needed, so it doesn't go through the Next backend either.

## Setup

1. Copy `.env.local` (already present) and confirm these are set:

   ```bash
   BLOCKS_API_URL=https://blocksapi.dev.slsblx.com
   BLOCKS_PROJECT_KEY=<project tenant id, x-blocks-key>
   BLOCKS_OIDC_CLIENT_ID=<oidc client id>
   BLOCKS_OIDC_CLIENT_SECRET=<oidc client secret>          # server-only, never exposed to the browser
   BLOCKS_REDIRECT_URI=http://localhost:3000/api/auth/callback
   SESSION_SECRET=<random, e.g. `openssl rand -base64 32`>

   NEXT_PUBLIC_BLOCKS_API_URL=https://blocksapi.dev.slsblx.com
   NEXT_PUBLIC_BLOCKS_PROJECT_KEY=<same project tenant id>

   # Storage/DMS — "local" (default) or "live"; see the Architecture section above
   NEXT_PUBLIC_BLOCKS_STORAGE_MODE=local
   NEXT_PUBLIC_BLOCKS_STORAGE_API_URL=http://localhost:9000
   ```

   `blocksapi.dev.slsblx.com` is this project's dedicated dev environment gateway for
   IAM (`/iam/v4/*`). Confirm the right host for another environment (test/stg/uat/prod)
   via that environment's `Project/Gets` entry rather than assuming `api.seliseblocks.com`.
   With `NEXT_PUBLIC_BLOCKS_STORAGE_MODE=local`, a standalone storage service must be
   running on the port `NEXT_PUBLIC_BLOCKS_STORAGE_API_URL` points at before folder/file
   features will work; set it to `live` to hit the main gateway instead and skip running
   one locally (`NEXT_PUBLIC_BLOCKS_STORAGE_API_URL` is then ignored).

2. **Register the redirect URI on the Blocks OIDC client.** `BLOCKS_REDIRECT_URI` must be
   listed in the `redirectUris` of both the OIDC client (`/iam/v4/oidc-clients`) and the
   `blocks-oidc` identity provider (`/iam/v4/auth/identity-providers`) for this project —
   see the `blocks-iam-sso-oidc-configuration` skill. Add the production callback URL
   there too before deploying.

3. `npm install && npm run dev`, then open `http://localhost:3000` — or, for HTTPS on
   the project's dev domain (required when `BLOCKS_REDIRECT_URI` is an `https://...`
   URL), see [HTTPS dev setup](#https-dev-setup) below.

Unlike a typical Blocks frontend, **you do not need `blocks-frontend-local-https`** —
this app never stores a Blocks session cookie in the browser. The only reason to run
HTTPS locally is when `BLOCKS_REDIRECT_URI` itself is `https://...` (so the callback
URL has to match over HTTPS).

## Data service: `/Directory/*` + `/Files/*`, not `/Files/GetDmsFileAndFolder`

This project's data service swagger
(`https://blocksapi.dev.slsblx.com/data/v4/swagger/v1/swagger.json`) exposes a
dedicated `/Directory/*` resource for folders — `GetDirectoryChildren`,
`CreateDirectory` / `CreateRootDirectory`, `DeleteDirectory` — alongside `/Files/*` for
file content (presign, download, delete). `src/lib/blocks/files.ts` targets that live
contract. Two things worth knowing:

- Calls skip the swagger's `/api` prefix — the endpoint is
  `.../data/v4/Directory/GetDirectoryChildren`, not `.../data/v4/api/Directory/...`.
- **`GetDirectoryChildren`'s response has no declared schema in the swagger** (the
  200 response is undocumented), so `normalizeDirectoryChildren` in `files.ts` guesses
  at the envelope and field names defensively, and `console.warn`s the raw shape in dev
  if nothing matches. Once you can log in and browse a folder, check the browser's
  Network tab for the real response and tighten that function up if the grid comes back
  empty where files are expected.

## Drive provisioning (BlxDrive) and sharing

Two more pieces run on top of `/Directory` and `/Files`:

- **Per-user drive root** — on login, `DriveProvider` (`src/components/providers/drive-provider.tsx`)
  looks up a `BlxDrive` record for the signed-in user via the Data Gateway
  (`src/lib/blocks/drives.ts`, `/data/v4/gateway` — GraphQL, on `BLOCKS_API_URL`, not the
  local storage service). If none exists, the user sees a one-time "Set up your drive"
  prompt; agreeing calls `POST /Directory/CreateDirectory` (no `parentDirectoryId`,
  `moduleName: 8`) and records the result as a new `BlxDrive` row. From then on, "My
  files" in the drive UI always resolves to that directory, never the raw storage root.
- **Sharing** — `src/lib/blocks/access.ts` wraps the storage service's `/Content/*`
  endpoints (`ShareContent`, `GrantAccess`/`UpdateAccessPolicy`, `RevokeAccessPolicy`,
  `GetAccessPolicies`), confirmed live against its swagger with clean string enums:
  `ContentPrincipalType` (`User`/`Role`/`Everyone`/`Organization`) and
  `ContentPermission` (`View`/`Download`/`Edit`/`Delete`/`Manage`/`Owner` — the share UI
  offers everything but `Owner`, which is system-assigned). The share dialog
  (`src/components/drive/share-dialog.tsx`, opened from a file/folder's "Share" menu
  item) picks a user from `usersApi.list()` or a role by `slug` from `rolesApi.list()` —
  both real dropdowns, not free text. As with the other DMS endpoints,
  `GetAccessPolicies`/`ShareContent`'s response shapes aren't in the swagger —
  `normalizeAccessPolicies` in `access.ts` guesses defensively; tighten it up against a
  real response if the shares list looks off.
- **Shared with me** — `GET /Content/GetSharedContent` (cursor/limit/type, no schema
  declared either) returns the top-level content shared with the signed-in user;
  `accessApi.getSharedContent` + `normalizeSharedContent` in `access.ts` wrap it, reusing
  the same row-parsing helpers as `GetDirectoryChildren` (`extractEntryList`,
  `parseDirectoryChildEntry`, exported from `files.ts`) since both return the same kind
  of file/directory row. The `/shared` page (`src/app/(app)/shared/page.tsx`, linked from
  the sidebar) shows that top level; opening a shared folder switches to a normal
  `GetDirectoryChildren` call for its children — access there is enforced server-side by
  the share, not by this page. It's read-only (no Share/Delete): a share may only grant
  View/Download, and `GetSharedContent` doesn't say what permission you hold on each row.

## HTTPS dev setup

The `.env.local` shipped here points `BLOCKS_REDIRECT_URI` at
`https://ssdlik.dev.slsblx.com:3000/api/auth/callback`, so the dev server has to serve
HTTPS on that hostname (or Blocks' OIDC callback won't match). One-time setup:

1. **Install `mkcert`** — <https://github.com/FiloSottile/mkcert#installation>. On
   Windows, `winget install FiloSottile.mkcert` is the simplest route.
2. **Trust the local CA** once per machine: `mkcert -install` (creates a root cert in
   your OS + browser trust stores so browsers stop warning).
3. **Generate a cert for this project** (cert + key land in `.cert/`, which is
   gitignored — `*.pem` is already covered too):

   ```bash
   mkdir -p .cert
   mkcert -cert-file .cert/dev-cert.pem -key-file .cert/dev-key.pem \
     ssdlik.dev.slsblx.com localhost 127.0.0.1 ::1
   ```

   The cert also includes `dntdxj.dev.slsblx.com` if you need to flip back to the
   earlier hostname; just re-run `mkcert` with whichever names you want as SANs.

4. **Map the hostname to localhost** — add to `C:\Windows\System32\drivers\etc\hosts`
   (edit as Administrator):

   ```
   127.0.0.1   ssdlik.dev.slsblx.com
   ```

5. **Start the dev server over HTTPS:**

   ```bash
   npm run dev:https
   ```

   That runs `next dev -H ssdlik.dev.slsblx.com -p 3000 --experimental-https
   --experimental-https-key .cert/dev-key.pem --experimental-https-cert
   .cert/dev-cert.pem`, giving you <https://ssdlik.dev.slsblx.com:3000>. The
   `allowedDevOrigins` entry in `next.config.ts` whitelists this hostname so HMR
   works on the custom domain.

   If `mkcert -install` was skipped or you're opening the site from a browser/device
   that doesn't trust the local CA, the browser will show a cert warning — proceed
   past it for dev only. Production needs a real cert (e.g. via the project's reverse
   proxy) registered on the Blocks OIDC client's `redirectUris`.

`npm run dev` (plain HTTP on `localhost:3000`) still works for any flow that doesn't
need the HTTPS callback URL to match.

## Fixed: wrong API host was causing `404 Application_Not_Found`

`idp/initiate` originally 404'd against `api.seliseblocks.com` — this project's SSO
client is only registered on its dedicated dev gateway, `blocksapi.dev.slsblx.com`
(confirmed live: the same call against that host returns a working authorize URL).
`.env.local` now points at it. If you add another environment, re-confirm its API host
the same way rather than assuming `api.seliseblocks.com`.

## Structure

```
src/lib/session.ts          this app's own session cookie (server-only)
src/lib/blocks-oidc.ts       Blocks OIDC calls made from the backend (server-only)
src/lib/auth-session.ts      token freshness/refresh orchestration (server-only)
src/app/api/auth/*           the OIDC route handlers described above
src/lib/blocks/*              browser-side Blocks API clients (bearer-token fetches)
  files.ts, drive-hooks.ts     Directory/Files (folders, upload, download, delete)
  access.ts                    Content sharing (/Content/*) — grant/update/revoke/list
  drives.ts                    BlxDrive lookup/insert via the Data Gateway
  users.ts, roles.ts           user email lookup, role list — for the share dialog
src/components/providers/    AuthProvider (session bootstrap) + DriveProvider + React Query
src/app/login, /activate     public auth pages
src/app/(app)/drive          the protected drive UI (folders, upload, download, delete, share)
```
