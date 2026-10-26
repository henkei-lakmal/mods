export type GitlabNamespace = {
  path: string
  kind: string
  plan: string
  minutesUsed: number
  minutesQuota: number
  storageBytes: number
  repositoryBytes: number
  lfsBytes: number
  openMrs: number
  registryBytes: number
  artifactsBytes: number
  storageLimitBytes: number
  seatsInUse: number
  maxSeatsUsed: number
}

export type AdoLicense = { name: string; assigned: number; total: number }

export type AdoUsage = {
  org: string
  hostedMinutesUsed: number
  hostedMinutesTotal: number
  hostedJobsUsed: number
  hostedJobsTotal: number
  selfHostedJobsUsed: number
  selfHostedJobsTotal: number
  licenses: AdoLicense[]
}

// One merge or pull request waiting on the person's review.
export type Review = {
  id: string
  title: string
  // `group/project!iid` on GitLab, `project/repo` on ADO.
  ref: string
  url: string
  author: string
  // The visibility group it belongs to: `gitlab:<path>` or `ado`.
  group: string
}

export type ReviewQueue = {
  awaiting: Review[]
  // Open across the tracked groups or org, whoever reviews them.
  open: number
  // Where every request awaiting the person's review is listed.
  listUrl: string
}

export type Snapshot = {
  gitlab: GitlabNamespace[]
  ado: AdoUsage | null
  mrs: ReviewQueue | null
  prs: ReviewQueue | null
  // Who the data is read as: the glab account and the ADO identity.
  gitlabUser: string
  adoUser: string
  errors: string[]
  updatedAt: number | null
  isRefreshing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'devops-consumption': { snapshot: Snapshot; warned: string[]; hidden: string[]; isPickerOpen: boolean; collapsed: string[] }
  }
}
