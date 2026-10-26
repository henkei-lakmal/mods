# devops-consumption

A Claude Code pane that tracks GitLab.com and Azure DevOps usage and review queues beside the chat, in cards styled like Claude's Context card:

- **GitLab**, per top-level namespace: monthly compute minutes against the plan quota, storage broken down into container registry, job artifacts, repository and other, seats, and open merge requests. An **Extra cost** section appears only when a namespace goes past its plan (compute at $10 per 1,000 minutes; repository + LFS storage at $5/month per 10 GiB; registry and artifacts are not billed).
- **Azure DevOps**: Microsoft-hosted pipeline minutes, hosted and self-hosted parallel jobs, and license use.
- **Merge requests** (in each GitLab group's card) and **pull requests** (in the Azure DevOps card): how many are open and how many await your review, linked to the page that lists them.

Click a card's title to fold it down to its main meter, and again to unfold it. A **Groups** line at the top folds open into tick boxes that hide or show each card; the choice is remembered across sessions. Meters turn amber at the warning percent and red at 100%, with one toast per meter per month. `/consumption` opens the pane and refreshes it.

## Setup

- `glab` signed in to gitlab.com (`glab auth login`).
- For Azure DevOps, one of: a PAT in Azure Key Vault that `az` can read (`az login`), a PAT in the mod's secret setting, or an `az` login whose tenant can issue Azure DevOps tokens. The PAT needs read access to Build, Agent Pools, Member Entitlement Management and Code.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `gitlabNamespaces` | all | Comma-separated top-level namespaces to fetch |
| `gitlabMinutesQuota` | plan default | Overrides 400 / 10,000 / 50,000 compute minutes |
| `adoOrg` | | The org in dev.azure.com/<org>; empty turns ADO off |
| `adoPatSecret` | | `vault/secret` holding the ADO PAT, e.g. `my-vault/ado-pat` |
| `adoPat` | | A PAT stored as a secret setting, used when no vault secret is set |
| `adoTenant` | read from the org | Entra tenant for `az account get-access-token` |
| `refreshMinutes` | 30 | Refresh interval, at least 5 |
| `warnPercent` | 80 | Percent at which a meter turns amber and alerts |

Set them in `~/.claude/settings.json` under `pluginConfigs["devops-consumption"].options`, or in `/config` from a terminal session.
