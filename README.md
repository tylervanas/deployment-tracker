# Deployment Tracker

A tiny local dashboard for tracking a staged deployment across many services:
tick off each service as its Azure DevOps pipeline finishes, so you can tell
DevOps about failures and give QA the green light, with everything visible
in one place.

## What it does

- Shows your services grouped the way you organize your releases (AG, Agora
  Management Studio, Identity, etc.) — edit `seed-data.json` to change the
  starting list, or add, rename, and remove services from the UI.
- For each service, paste either a Build run URL containing `buildId`, or a
  classic Release environment URL containing `releaseId` and `environmentId`.
- The bulk importer accepts a deployment message, Markdown links, or plain
  URLs. It strips all non-URL text and uses only Azure's verified pipeline name
  or a previously approved alias for placement. Human headings and labels are
  never considered. Bulk import requires a PAT.
- Import results identify duplicate runs, URLs already assigned to configured
  rows, replacements, malformed/unsupported links, Azure lookup errors, and
  unknown services. Resolved Azure pipeline names are shown with each issue.
- **Clear all links** leaves the bulk paste/review intact. **Clean Run** verifies
  the pasted URLs, clears all active service links, then imports the verified
  matches in one operation.
- Hit **Refresh** (or **Refresh all**) and the app calls the Azure DevOps
  REST API to check whether that run is queued, running, succeeded, failed,
  awaiting approval, or finished with warnings. It shows the Azure pipeline
  name in brackets, flags name mismatches, and provides a shareable run/failure
  link.
- When a technical Azure name is correct but differs from the application
  label, **Correct Pipeline** approves it as a persistent alias. Future bulk
  imports use that alias across current, historical, and new deployments.
- Auto-refresh is enabled by default and checks all configured runs every 15s.
- Queue-enabled services can be started with a selected branch and deployment
  target. **Queue all** previews the plan and groups services that share an
  identical build, so one build artifact can feed multiple classic releases.
- For build-to-release services, the tracker follows the queued build and,
  after it succeeds, creates the configured classic release and starts the
  selected environment. Queue configuration is discovered and verified one
  pipeline at a time; unconfigured service buttons remain disabled.
- Classic release environments waiting on DevOps/AppAdmin approval show an
  **Awaiting approval** status. **Copy approval links** creates a labeled list
  of every pending release-environment URL for sharing with approvers.
- Name deployments and use **New** to preserve the active deployment in
  history while starting a blank one with the same service layout.
- If a saved deployment has been edited, **New** asks whether to save those
  changes to the same history entry before continuing; it does not create a
  duplicate snapshot. Automatic status refreshes do not mark it as changed.
- Switch among previous deployments from the History menu. **Clear all links**
  clears only the active deployment; **Reset statuses** keeps its links.

## Is this possible with a token? Yes.

Azure DevOps supports **Personal Access Tokens (PAT)** for the REST API.
This app uses the [Builds - Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/get)
endpoint with Basic auth (`Authorization: Basic base64(":"+PAT)`).

To create one:
1. Azure DevOps → user icon (top right) → **Personal access tokens**.
2. **New Token** → give it a name → select **Build (Read)** and
  **Release (Read)** → set a short expiry.
3. Paste it into the "PAT token" box at the top of the app and click **Save**.

The token is stored **only in your browser's `localStorage`**, sent directly
from the browser to this local server per request, and is never written to
disk by the server. It is only forwarded to `dev.azure.com` to check status.
Treat it like a password — don't paste it into a shared/public machine, and
use a short expiry + minimal scope.

## Running it

```powershell
npm install
npm start
```

Then open http://localhost:4173

## Project layout

- `server.js` — Express server + API routes
- `lib/store.js` — reads/writes `data.json` (created on first run from
  `seed-data.json`); holds the service list, pipeline URLs and last-known
  status. No tokens are ever persisted here.
- `lib/ado.js` — parses pipeline URLs and calls the Azure DevOps REST API.
- `public/` — the frontend (plain HTML/CSS/JS, no build step).
