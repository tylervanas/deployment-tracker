# Environment & Region Mapping

Generated from `data.json` (`state.queueConfigs`) on 7 Sep 2026.

This is what the tracker sends to Azure DevOps for each **Environment** (and **Region**, where applicable) selection.

## How selections resolve

- **Environment** dropdown: `Dev`, `QA`, `Release`, `Staging`, `Demo`, `Production`.
- **Region** dropdown appears only for **Regional + Production** and offers `NA`, `EMEA`, `APAC`.
  Regional services therefore have three separate production targets, keyed `Production:NA`, `Production:EMEA`, `Production:APAC`.
- **Global** services have a single `Production` target; where a service spans datacentres, one selection fans out to several release environments at once.
- **CUS wins over NA.** Where a pipeline has both a `Prod-CUS` and a legacy `Prod-NA` environment, `Production:NA` maps to **CUS**. `NA` is only used when no CUS environment exists.
- **Excluded on purpose:** slot targets (`*-slot`) and perf targets (`perf-*`) are never mapped.

Two mechanisms are used depending on pipeline type:

| Type | Mechanism |
| --- | --- |
| `build-release` | Selection picks a **release environment ID** on the classic release definition. |
| `build` | Selection sets the pipeline's `environment` template parameter to a **string value**. |
| `package-release` | Selection picks a release environment ID; artifact is an Azure Artifacts package version. |

---

## Regional — release-based services

Values are `Environment name (release environment ID)`.

| Service | Build def | Release def | Dev | QA | Release | Staging | Demo | Prod NA | Prod EMEA | Prod APAC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AG Home SWA | 273 | 48 `AG-HOME` | DEV (330) | QA CUS (404) | Release CUS (411) | Staging-cus (410) | Demo CUS (414) | Prod-CUS (435) | Prod-EMEA (348) | Prod-APAC (349) |
| Old AG Admin | 273 | 49 `AG-ADMIN` | DEV (336) | QA CUS (403) | Release CUS (412) | Staging-cus (409) | Demo CUS (413) | Prod CUS (434) | Prod EMEA (346) | Prod APAC (347) |
| Agora Admin SWA | 6345 | 59 `Agora-Admin-SWA` | DEV (436) | QA (437) | Release (438) | Staging (439) | Demo (440) | Prod-CUS (441) | Prod-GBR (443) | Prod-AUS (442) |
| AG Administration Identity | 6345 | 66 | Dev (484) | QA (485) | Release (486) | Staging (487) | Demo (488) | Prod-NA (489) | Prod-EMEA (491) | Prod-APAC (490) |
| AG Administration Gateway | 6345 | 61 | Dev (450) | QA (454) | Release (455) | Staging (456) | Demo (457) | Prod-NA (458) | Prod-EMEA (477) | Prod-APAC (476) |
| AG Administration Access Management | 6345 | 62 | Dev (451) | QA (469) | Release (470) | Staging (471) | Demo (472) | Prod-NA (473) | Prod-EMEA (478) | Prod-APAC (475) |

> Note: the two `Prod-GBR` / `Prod-AUS` names on Agora Admin SWA are the same thing as EMEA / APAC elsewhere.

## Regional — build-only services

Values are the `environment` template parameter string.

| Service | Build def | Dev | QA | Release | Staging | Demo | Prod NA | Prod EMEA | Prod APAC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Config Function Home | 3722 | `dev` | `qa-CUS` | `release-CUS` | `staging-CUS` | `demo-CUS` | `prod-CUS` | `prod-EMEA` | `prod-APAC` |
| Config Function Admin | 6193 | `dev` | `qa` | `release` | `staging` | `demo` | `prod-NA` | `prod-EMEA` | `prod-APAC` |
| Notifications API | 2898 | `dev` | `qa-CUS` | `release-CUS` | `staging-CUS` | `demo-CUS` | `prod-CUS` | `prod-EMEA` | `prod-APAC` |
| AG Administration API | 6190 | `devtest` | `qa` | `release` | `staging` | `demo` | `prod-NA` | `prod-EMEA` | `prod-APAC` |
| AG API | 2878 | `dev` | `qa-CUS` | `release-CUS` | `staging-CUS` | `demo-CUS` | `prod-CUS` | `prod-EMEA` | `prod-APAC` |

---

## Global Widget

Package-artifact release. No region dropdown — a single `Production` target.

| Service | Release def | Dev | QA | Release | Staging | Demo | Production |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Widget | 55 | dev (397) | QA-CUS (398) | Release-CUS (405) | Staging-CUS (406) | Demo-CUS (408) | Production-CUS (407) |

Feed `58da92fa-dde6-414e-8e23-602fd171f90f`, package `ab288494-2b4f-4558-a4ac-6ea6e7bc0edf`, default version `6.1.3`.

---

## Global — release-based services

| Service | Build def | Release def | Dev | QA | Release | Staging | Demo | Production |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Internal Admin SWA | 5380 | 50 | DEV (350) | QA (370) | Release-CUS (352) + Release-AUS (373) + Release-GBR (374) | Staging-CUS (384) + Staging-GBR (388) + Staging-AUS (389) | Demo-CUS (377) + Demo-GBR (378) + Demo-AUS (379) | Production-CUS (385) + Production-GBR (386) + Production-AUS (387) |
| MFE (Gateway) | 5380 | 51 | dev (358) | qa (371) | Release-USA (360) | Staging-USA (392) | Demo-USA (380) | Prod-USA (393) |
| MFE (Identity) | 5380 | 52 | dev (364) | qa (372) | Release-USA (366) | Staging-USA (390) | Demo-USA (381) | Prod-USA (391) |

> Internal Admin SWA is the one that **fans out to three datacentres in a single queue** (CUS + GBR + AUS).

## Global — build-only services

Region is baked into the service row (one row per region), so `Production` is a single option per row.

| Service | Build def | Dev | QA | Release | Staging | Demo | Production |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Yarp API (NA) | 5385 | `dev` | `qa` | `release-NA` | `staging-NA` | `demo-NA` | `prod-NA` |
| Yarp API (EMEA) | 5385 | `dev` | `qa` | `release-EMEA` | `staging-EMEA` | `demo-EMEA` | `prod-EMEA` |
| Yarp API (APAC) | 5385 | `dev` | `qa` | `release-APAC` | `staging-APAC` | `demo-APAC` | `prod-APAC` |
| Config and Manifest Function (NA) | 5384 | `dev` | `qa` | `release-NA` | `staging-NA` | `demo-NA` | `prod-NA` |
| Config and Manifest Function (EMEA) | 5384 | `dev` | `qa` | `release-EMEA` | `staging-EMEA` | `demo-EMEA` | `prod-EMEA` |
| Config and Manifest Function (APAC) | 5384 | `dev` | `qa` | `release-APAC` | `staging-APAC` | `demo-APAC` | `prod-APAC` |

## Global — Identity family

These all use a `datacenter` template parameter of **`ia01`** in addition to `environment`.
(Audited: no `ia02` or `.02` variant exists on any of these definitions.)

| Service | Build def | Dev | QA | Release | Staging | Demo | Production |
| --- | --- | --- | --- | --- | --- | --- | --- |
| New Central Identity | 6098 | `dev - jh01` | `qa - jh01` | `release_GLOBAL` | `staging_GLOBAL` | `demo_GLOBAL` | `prod_GLOBAL` |
| Pathfinder | 3320 | `dev - jh01` | `qa - jh01` | `release_GLOBAL` | `staging_GLOBAL` | `demo_GLOBAL` | `prod_GLOBAL` |
| Hello | 3764 | `dev - jh01` | `qa - jh01` | `release_GLOBAL` | `staging_GLOBAL` | `demo_GLOBAL` | `prod_GLOBAL` |
| Proxy | 3765 | `dev - jh01` | `qa - jh01` | `release_GLOBAL` | `staging_GLOBAL` | `demo_GLOBAL` | `prod_GLOBAL` |
| Sync | 3709 | `dev - jh01` | `qa - jh01` | `release_GLOBAL` | `staging_GLOBAL` | `demo_GLOBAL` | `prod_GLOBAL` |

## Not configured for queueing

| Service | Reason |
| --- | --- |
| Welcome | Deployed via Octopus, tracking only. |

---

## Branches

| Family | Default branch |
| --- | --- |
| AG (Regional) | `refs/heads/release/release-ag-2026.03` |
| IAM (Global) | `refs/heads/release/release-iam-2026.03` |

`resolveBranch` translates between the two families, so picking one release train in the UI selects the matching branch for each service.

## Mono-repo parent pipelines

Queueing defaults to **redeploying the newest release built from the selected branch**. A new build only runs when
**Force new build and release** is ticked on the parent block.

| Parent pipeline | Children | Parameters used when forcing a new build |
| --- | --- | --- |
| 273 `mri-platform-ag-client-admin-mono-repo` | AG Home SWA, Old AG Admin | `affected_projects = ag-home,ag-admin,ag-widget` |
| 6345 `MRI-Software.MRI.Agora.Adminstration-mono-repo` | Agora Admin SWA, AG Administration Identity / Gateway / Access Management | `buildAll = true` plus the six-app `apps` list |
| 5380 `MRI-Software.MRI.Agora.Internal.Adminstration-Mono-Repo` | Internal Admin SWA, MFE (Gateway), MFE (Identity) | — |
