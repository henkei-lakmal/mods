import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AdoLicense, AdoUsage, GitlabNamespace, ReviewQueue, Snapshot } from '../types'

const PANE = 'devops-consumption'
const TITLE = 'GitLab & ADO consumption'
// The Azure DevOps resource ID for `az account get-access-token`.
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6b56798'
// GitLab.com monthly compute minutes per plan, used when no quota is set.
const PLAN_MINUTES: Record<string, number> = { free: 400, premium: 10000, ultimate: 50000 }
// The ADO licenses worth a row; the rest of the summary is noise.
const LICENSES = ['Basic', 'Basic + Test Plans', 'Stakeholder', 'Visual Studio Subscriber']

const EMPTY: Snapshot = { gitlab: [], ado: null, mrs: null, prs: null, errors: [], updatedAt: null, isRefreshing: false }
const snapshot = atom({ plugin: 'devops-consumption', key: 'snapshot' } as const, EMPTY)
const warned = atom({ plugin: 'devops-consumption', key: 'warned' } as const, [] as string[])
// Groups unticked in the pane's Show row, as `gitlab:<path>` or `ado`; kept in
// the store too, so the choice outlives the session.
const hidden = atom({ plugin: 'devops-consumption', key: 'hidden' } as const, [] as string[])
const isPickerOpen = atom({ plugin: 'devops-consumption', key: 'isPickerOpen' } as const, false)
// Cards folded to their headline, by card key; kept in the store too.
const collapsed = atom({ plugin: 'devops-consumption', key: 'collapsed' } as const, [] as string[])
// ADO's "no limit", as int32's largest value.
const UNLIMITED = 2147483647

type Meter = { label: string; used: number; total: number }
type Config = {
  only: string[]
  gitlabQuota: number
  org: string
  tenant: string
  pat: string
  patSecret: string
  refreshMs: number
  warnAt: number
}

let config: Config = { only: [], gitlabQuota: 0, org: '', tenant: '', pat: '', patSecret: '', refreshMs: 1800000, warnAt: 80 }
let token: { value: string; expiresAt: number } | null = null
let inFlight: Promise<void> | null = null
let discoveredTenant = ''
let vaulted: { value: string; readAt: number } | null = null
let gitlabUser = ''
let adoUserId = ''

async function run($: EngineInterface, argv: string[]): Promise<string> {
  let done
  try {
    done = await $.process.run(argv, { timeoutMs: 60000 })
  } catch {
    // On Windows `az` is a .cmd script, which only cmd.exe starts.
    done = await $.process.run(['cmd', '/c', ...argv], { timeoutMs: 60000 })
  }
  if (done.exitCode !== 0) {
    throw new Error(`${argv.slice(0, 3).join(' ')}: ${(done.stderr || done.stdout).trim().split('\n')[0]}`)
  }

  return done.stdout
}

async function gitlab($: EngineInterface): Promise<GitlabNamespace[]> {
  const listed: { id: number; full_path: string; kind: string }[] = JSON.parse(
    await run($, ['glab', 'api', 'namespaces?top_level_only=true&per_page=100']),
  )
  const picked = listed.filter(ns => config.only.length === 0 || config.only.includes(ns.full_path))

  return Promise.all(picked.map(ns => gitlabNamespace($, ns)))
}

async function gitlabNamespace(
  $: EngineInterface,
  ns: { id: number; full_path: string; kind: string },
): Promise<GitlabNamespace> {
  const detail = JSON.parse(await run($, ['glab', 'api', `namespaces/${ns.id}`]))
  // `group` is null for a user namespace, which has no group MR list.
  const query = `query { namespace(fullPath: "${ns.full_path}") { actualRepositorySizeLimit rootStorageStatistics { storageSize repositorySize lfsObjectsSize buildArtifactsSize containerRegistrySize } } group(fullPath: "${ns.full_path}") { mergeRequests(state: opened, includeSubgroups: true) { count } } }`
  const graph = JSON.parse(await run($, ['glab', 'api', 'graphql', '-f', `query=${query}`]))
  const space = graph.data?.namespace
  const stats = space?.rootStorageStatistics ?? {}
  const plan: string = detail.plan ?? 'free'

  return {
    path: ns.full_path,
    kind: ns.kind,
    plan,
    minutesUsed: detail.ci_minutes_usage?.monthly_minutes_used ?? 0,
    minutesQuota: config.gitlabQuota > 0 ? config.gitlabQuota : (PLAN_MINUTES[plan] ?? 400),
    storageBytes: stats.storageSize ?? 0,
    repositoryBytes: stats.repositorySize ?? 0,
    lfsBytes: stats.lfsObjectsSize ?? 0,
    openMrs: graph.data?.group?.mergeRequests?.count ?? 0,
    registryBytes: stats.containerRegistrySize ?? 0,
    artifactsBytes: stats.buildArtifactsSize ?? 0,
    storageLimitBytes: space?.actualRepositorySizeLimit ?? 0,
    seatsInUse: detail.seats_in_use ?? 0,
    maxSeatsUsed: detail.max_seats_used ?? 0,
  }
}

async function gitlabReviews($: EngineInterface, spaces: GitlabNamespace[]): Promise<ReviewQueue> {
  if (!gitlabUser) {
    gitlabUser = JSON.parse(await run($, ['glab', 'api', 'user'])).username as string
  }
  const listed: {
    iid: number
    title: string
    web_url: string
    references: { full: string }
    author: { username: string }
  }[] = JSON.parse(
    await run($, [
      'glab',
      'api',
      `merge_requests?scope=all&state=opened&reviewer_username=${gitlabUser}&per_page=100`,
    ]),
  )
  const tracked = spaces.map(ns => ns.path)
  const awaiting = listed
    .map(mr => ({
      id: mr.web_url,
      title: mr.title,
      ref: mr.references.full,
      url: mr.web_url,
      author: mr.author.username,
      group: `gitlab:${mr.references.full.split('/')[0]}`,
    }))
    .filter(mr => tracked.includes(mr.group.slice('gitlab:'.length)))

  return {
    awaiting,
    open: spaces.reduce((sum, ns) => sum + ns.openMrs, 0),
    listUrl: `https://gitlab.com/dashboard/merge_requests?reviewer_username=${gitlabUser}`,
  }
}

// PRs where the person is a reviewer and has not voted yet.
async function adoReviews($: EngineInterface): Promise<ReviewQueue> {
  if (!adoUserId) {
    const me = await adoGet($, `https://dev.azure.com/${config.org}/_apis/connectionData`)
    adoUserId = me.authenticatedUser?.id ?? ''
  }
  const base = `https://dev.azure.com/${config.org}/_apis/git/pullrequests?searchCriteria.status=active&api-version=7.1`
  const [mine, all] = await Promise.all([
    adoGet($, `${base}&searchCriteria.reviewerId=${adoUserId}&$top=200`),
    adoGet($, `${base}&$top=1000`),
  ])
  type Pr = {
    pullRequestId: number
    title: string
    createdBy?: { displayName?: string }
    repository: { name: string; project: { name: string } }
    reviewers?: { id: string; vote: number }[]
  }
  const awaiting = ((mine.value ?? []) as Pr[])
    .filter(pr => (pr.reviewers ?? []).some(one => one.id === adoUserId && one.vote === 0))
    .map(pr => {
      const project = pr.repository.project.name
      const repo = pr.repository.name
      return {
        id: String(pr.pullRequestId),
        title: pr.title,
        ref: `${project}/${repo}`,
        url: `https://dev.azure.com/${config.org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${pr.pullRequestId}`,
        author: pr.createdBy?.displayName ?? '',
        group: 'ado',
      }
    })

  return { awaiting, open: (all.value ?? []).length, listUrl: `https://dev.azure.com/${config.org}/_pulls` }
}

async function adoToken($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  if (token && token.expiresAt - now > 5 * 60000) {
    return token.value
  }
  const tenant = config.tenant || (await adoTenant($))
  const argv = ['az', 'account', 'get-access-token', '--resource', ADO_RESOURCE, '-o', 'json']
  let got
  try {
    got = JSON.parse(await run($, tenant ? [...argv, '--tenant', tenant] : argv))
  } catch {
    throw new Error(
      `az has no Azure DevOps token for tenant ${tenant || '(default)'}: set a PAT in the mod's settings, or run az login --tenant ${tenant || '<tenant>'}`,
    )
  }
  token = { value: got.accessToken, expiresAt: Number(got.expires_on) * 1000 || now + 30 * 60000 }

  return token.value
}

// ADO names the org's tenant on an anonymous request; suppressing the
// sign-in redirect makes that a plain 401 carrying the header.
async function adoTenant($: EngineInterface): Promise<string> {
  if (discoveredTenant) {
    return discoveredTenant
  }
  const answer = await $.http.fetch(`https://dev.azure.com/${config.org}/_apis/connectionData`, {
    headers: { 'X-TFS-FedAuthRedirect': 'Suppress' },
  })
  discoveredTenant = answer.headers['x-vss-resourcetenant'] ?? ''

  return discoveredTenant
}

// The PAT stays in the module, never in state, and is read again once an hour.
async function vaultPat($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  if (vaulted && now - vaulted.readAt < 3600000) {
    return vaulted.value
  }
  const [vault, name] = config.patSecret.split('/')
  if (!vault || !name) {
    throw new Error(`the Key Vault setting "${config.patSecret}" is not vault/secret`)
  }
  let value
  try {
    value = (
      await run($, ['az', 'keyvault', 'secret', 'show', '--vault-name', vault, '--name', name, '--query', 'value', '-o', 'tsv'])
    ).trim()
  } catch {
    throw new Error(`could not read ${name} from Key Vault ${vault}: check az login and the vault's access`)
  }
  vaulted = { value, readAt: now }

  return value
}

async function adoGet($: EngineInterface, url: string) {
  const pat = config.patSecret ? await vaultPat($) : config.pat
  const authorization = pat ? `Basic ${btoa(`:${pat}`)}` : `Bearer ${await adoToken($)}`
  const answer = await $.http.fetch(url, {
    headers: { Authorization: authorization, Accept: 'application/json' },
  })
  if (answer.text.trimStart().startsWith('<')) {
    throw new Error(`ADO answered with a sign-in page: set the tenant that backs "${config.org}"`)
  }
  if (!answer.ok) {
    throw new Error(`ADO ${answer.status} on ${url.split('?')[0]}`)
  }

  return JSON.parse(answer.text)
}

async function adoPool($: EngineInterface, isHosted: boolean) {
  return adoGet(
    $,
    `https://dev.azure.com/${config.org}/_apis/distributedtask/resourceusage?parallelismTag=Private&poolIsHosted=${isHosted}&includeRunningRequests=false&api-version=7.1-preview.1`,
  )
}

async function ado($: EngineInterface): Promise<AdoUsage> {
  const [hosted, selfHosted, summary] = await Promise.all([
    adoPool($, true),
    adoPool($, false),
    adoGet(
      $,
      `https://vsaex.dev.azure.com/${config.org}/_apis/userentitlementsummary?select=Licenses&api-version=7.1-preview.1`,
    ),
  ])
  const licenses: AdoLicense[] = (summary.licenses ?? [])
    .filter((one: { licenseName: string }) => LICENSES.includes(one.licenseName))
    .map((one: { licenseName: string; assigned: number; total: number }) => ({
      name: one.licenseName,
      assigned: one.assigned ?? 0,
      total: one.total ?? 0,
    }))

  return {
    org: config.org,
    hostedMinutesUsed: hosted.usedMinutes ?? 0,
    hostedMinutesTotal: hosted.resourceLimit?.totalMinutes ?? 0,
    hostedJobsUsed: hosted.usedCount ?? 0,
    hostedJobsTotal: hosted.resourceLimit?.totalCount ?? 0,
    selfHostedJobsUsed: selfHosted.usedCount ?? 0,
    selfHostedJobsTotal: selfHosted.resourceLimit?.totalCount ?? 0,
    licenses,
  }
}

async function refresh($: EngineInterface): Promise<void> {
  if (inFlight) {
    return inFlight
  }
  inFlight = load($).finally(() => {
    inFlight = null
  })

  return inFlight
}

async function load($: EngineInterface): Promise<void> {
  await update($, snapshot, snap => ({ ...snap, isRefreshing: true }))
  const errors: string[] = []
  // Each source fails alone: its error is kept under its own prefix and its
  // last good value stays on screen.
  const failed = (source: string) => (error: unknown) => {
    errors.push(`${source}: ${(error as Error).message}`)
    return null
  }
  const [gl, az, prs] = await Promise.all([
    gitlab($).catch(failed('GitLab')),
    config.org ? ado($).catch(failed('ADO')) : Promise.resolve(null),
    config.org ? adoReviews($).catch(failed('PRs')) : Promise.resolve(null),
  ])
  const mrs = gl ? await gitlabReviews($, gl).catch(failed('MRs')) : null
  const now = await $.clock.now()
  const next = await update($, snapshot, snap => ({
    gitlab: gl ?? snap.gitlab,
    ado: az ?? (config.org ? snap.ado : null),
    mrs: mrs ?? snap.mrs,
    prs: prs ?? (config.org ? snap.prs : null),
    errors,
    updatedAt: now,
    isRefreshing: false,
  }))

  // One toast per meter per month once it crosses the warning line.
  const month = new Date(now).toISOString().slice(0, 7)
  const off = await read($, hidden)
  const hot = meters(next, off).filter(one => one.total > 0 && ratio(one) * 100 >= config.warnAt)
  const seen = await read($, warned)
  const fresh = hot.filter(one => !seen.includes(`${month} ${one.label}`))
  if (fresh.length > 0) {
    $.ui.toast(fresh.map(one => `${one.label}: ${percent(one)}% of quota`).join(' · '))
    await update($, warned, list => [...list, ...fresh.map(one => `${month} ${one.label}`)].slice(-50))
  }
  const top = meters(next, off).sort((a, b) => ratio(b) - ratio(a))[0]
  $.ui.status(top ? `${top.label.replace(' minutes', '')} ${percent(top)}% min` : undefined)
}

async function toggleGroup($: EngineInterface, id: string): Promise<void> {
  const next = await update($, hidden, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))
  await $.store.set('hidden', next)
  const top = meters(await read($, snapshot), next).sort((a, b) => ratio(b) - ratio(a))[0]
  $.ui.status(top ? `${top.label.replace(' minutes', '')} ${percent(top)}% min` : undefined)
}

async function toggleCard($: EngineInterface, key: string): Promise<void> {
  const next = await update($, collapsed, list => (list.includes(key) ? list.filter(one => one !== key) : [...list, key]))
  await $.store.set('collapsed', next)
}

async function togglePicker($: EngineInterface): Promise<void> {
  const next = await update($, isPickerOpen, open => !open)
  await $.store.set('isPickerOpen', next)
}

export const register: Register = (on, options) => {
  config = {
    only: String(options.gitlabNamespaces ?? '')
      .split(',')
      .map(one => one.trim())
      .filter(Boolean),
    gitlabQuota: Number(options.gitlabMinutesQuota ?? 0),
    org: String(options.adoOrg ?? '').trim(),
    tenant: String(options.adoTenant ?? '').trim(),
    pat: String(options.adoPat ?? '').trim(),
    patSecret: String(options.adoPatSecret ?? '').trim(),
    refreshMs: Math.max(5, Number(options.refreshMinutes ?? 30)) * 60000,
    warnAt: Number(options.warnPercent ?? 80),
  }
  token = null
  discoveredTenant = ''
  vaulted = null
  gitlabUser = ''
  adoUserId = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'consumption',
      description: 'Show GitLab and Azure DevOps consumption in a pane and refresh it',
    })
    const saved = await $.store.get('hidden')
    if (Array.isArray(saved)) {
      await update($, hidden, () => saved.filter((one): one is string => typeof one === 'string'))
    }
    const folded = await $.store.get('collapsed')
    if (Array.isArray(folded)) {
      await update($, collapsed, () => folded.filter((one): one is string => typeof one === 'string'))
    }
    if ((await $.store.get('isPickerOpen')) === true) {
      await update($, isPickerOpen, () => true)
    }
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(config.refreshMs, () => refresh($))

    return next(e)
  })

  on('command.run', { command: 'consumption' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    const snap = await read($, snapshot)
    const lines = meters(snap).map(one => `${one.label}: ${fmt(one.used)} / ${fmt(one.total)} (${percent(one)}%)`)

    return { text: [...lines, ...snap.errors].join('\n') || 'Nothing to track yet.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const off = await read($, hidden)
    // The card's border and padding take four cells of the body, and a
    // scrollbar may take two more.
    const width = Math.max(10, (e.props.bodyColumns ?? 40) - 6)
    const errorsOf = (source: string) =>
      snap.errors.filter(one => one.startsWith(`${source}:`)).map(one => one.slice(source.length + 1).trim())

    // A thin bar of colored segments over a dim track, as Context's.
    const strip = (parts: { color: string; value: number }[], total: number, cells: number) => {
      let left = cells
      const segments = parts.map(part => {
        const size = total > 0 ? Math.min(left, Math.round((part.value / total) * cells)) : 0
        left -= size
        return <Text color={part.color}>{'━'.repeat(size)}</Text>
      })
      // Monospaced, so a cell is the width `bodyColumns` counts in.
      return (
        <Text mono wrap="truncate">
          {segments}
          <Text dimColor>{'━'.repeat(left)}</Text>
        </Text>
      )
    }

    // A card whose title folds it, as Context's "Context ▾": folded, it keeps
    // its `summary` (its main meter) and drops the rest of `body`.
    const folded = await read($, collapsed)
    const card = (key: string, title: string, aside: string, body: RenderChildren, summary?: RenderChildren) => {
      const isFolded = folded.includes(key)
      return (
        <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginBottom={1}>
            <Button
              key={`fold-${key}`}
              label={`${title} ${isFolded ? '▸' : '▾'}`}
              plain
              onPress={() => toggleCard($, key)}
            />
            <Text dimColor size="caption">
              {aside}
            </Text>
          </Box>
          {isFolded ? summary : body}
        </Box>
      )
    }

    // The headline and bar of one meter, as Context's "17% used … 174.7k / 1M".
    const usage = (key: string, one: Meter, unit: string) => (
      <Box key={key} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="semibold" size="footnote">
            {one.total > 0 ? `${percent(one)}% used` : `${fmt(one.used)} ${unit}`}
          </Text>
          <Text dimColor tabular size="caption">
            {one.total > 0 ? `${fmt(one.used)} / ${fmt(one.total)} ${unit}` : 'no limit'}
          </Text>
        </Box>
        {strip([{ color: tone(one), value: Math.min(one.used, one.total || one.used) }], one.total || one.used, width)}
      </Box>
    )

    // Three columns: the label takes what is left and truncates, the value and
    // the share sit in fixed right-aligned columns, so every row lines up.
    const row = (key: string, color: string, label: string, value: string, share: string) => (
      <Box key={key} flexDirection="row">
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text wrap="truncate-end" size="footnote">
            <Text color={color}>■</Text> {label}
          </Text>
        </Box>
        <Box width={11} flexShrink={0} justifyContent="flex-end">
          <Text dimColor tabular wrap="truncate" size="footnote">
            {value}
          </Text>
        </Box>
        <Box width={7} flexShrink={0} justifyContent="flex-end">
          <Text dimColor tabular size="footnote">
            {share}
          </Text>
        </Box>
      </Box>
    )

    // A review summary in a card's row: the label links to the list where the
    // requests are reviewed, the value is how many are open, the last column
    // how many wait on the person.
    const reviewRow = (key: string, label: string, href: string, open: number, mine: number) => (
      <Box key={key} flexDirection="row">
        <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text size="footnote" color={mine > 0 ? 'suggestion' : 'subtle'}>
            ■{' '}
          </Text>
          <Link href={href} label={`${label} ›`} />
        </Box>
        <Box width={11} flexShrink={0} justifyContent="flex-end">
          <Text dimColor tabular size="footnote">
            {open} open
          </Text>
        </Box>
        <Box width={7} flexShrink={0} justifyContent="flex-end">
          <Text dimColor={mine === 0} tabular size="footnote">
            {mine} you
          </Text>
        </Box>
      </Box>
    )

    const meterRow = (key: string, label: string, used: number, limit: number) => {
      const total = limit >= UNLIMITED ? 0 : limit
      const one = { label, used, total }
      return row(key, tone(one), label, total > 0 ? `${fmt(used)} / ${fmt(total)}` : fmt(used), total > 0 ? `${percent(one)}%` : '')
    }

    // The group picker: folded to one line, opening onto a tick box per
    // group, ticked while its card shows.
    const groups = [
      ...snap.gitlab.map(ns => ({ id: `gitlab:${ns.path}`, label: ns.path })),
      ...(config.org ? [{ id: 'ado', label: `ADO ${config.org}` }] : []),
    ]
    const isOpen = await read($, isPickerOpen)
    const shown = groups.filter(group => !off.includes(group.id)).length
    const showRow = groups.length > 0 && (
      <Box flexDirection="column" marginBottom={1} paddingX={1}>
        <Button
          key="groups"
          label={`Groups · ${shown} of ${groups.length} ${isOpen ? '▾' : '▸'}`}
          plain
          dimColor
          onPress={() => togglePicker($)}
        />
        {isOpen && (
          <Box flexDirection="row" flexWrap="wrap" gap="xs">
            {groups.map(group => (
              <Button
                key={`show-${group.id}`}
                label={`${off.includes(group.id) ? '☐' : '☑'} ${group.label}`}
                plain
                dimColor={off.includes(group.id)}
                onPress={() => toggleGroup($, group.id)}
              />
            ))}
          </Box>
        )}
      </Box>
    )

    const gitlabCards = snap.gitlab.filter(ns => !off.includes(`gitlab:${ns.path}`)).map(ns => {
      const other = Math.max(0, ns.storageBytes - ns.repositoryBytes - ns.registryBytes - ns.artifactsBytes)
      const parts = [
        { color: 'suggestion', label: 'Container registry', value: ns.registryBytes },
        { color: 'claude', label: 'Job artifacts', value: ns.artifactsBytes },
        { color: 'success', label: 'Repository', value: ns.repositoryBytes },
        { color: 'warning', label: 'Other', value: other },
      ]
      const share = (value: number) => (ns.storageBytes > 0 ? `${((value / ns.storageBytes) * 100).toFixed(1)}%` : '')
      const cost = costOf(ns)
      const compute = usage(`gl-${ns.path}-min`, { label: 'Compute', used: ns.minutesUsed, total: ns.minutesQuota }, 'min')

      return card(
        `gl-${ns.path}`,
        `GitLab · ${ns.path}`,
        ns.plan,
        <Box flexDirection="column">
          {compute}
          <Box flexDirection="row" justifyContent="space-between">
            <Text weight="semibold" size="footnote">
              Storage
            </Text>
            <Text dimColor tabular size="caption">
              {bytes(ns.storageBytes)}
            </Text>
          </Box>
          {strip(parts, ns.storageBytes, width)}
          <Box flexDirection="column" marginTop={1}>
            {parts.map(part => row(`gl-${ns.path}-${part.label}`, part.color, part.label, bytes(part.value), share(part.value)))}
            {row(`gl-${ns.path}-seats`, 'subtle', 'Seats', `${ns.seatsInUse} · max ${ns.maxSeatsUsed}`, '')}
            {ns.kind === 'group' &&
              reviewRow(
                `gl-${ns.path}-mrs`,
                'Merge requests',
                `https://gitlab.com/groups/${ns.path}/-/merge_requests`,
                ns.openMrs,
                (snap.mrs?.awaiting ?? []).filter(one => one.group === `gitlab:${ns.path}`).length,
              )}
          </Box>
          {/* Shown only when the namespace has gone past what its plan includes. */}
          {cost.compute + cost.storage > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text weight="semibold" size="footnote">
                Extra cost
              </Text>
              {cost.compute > 0 &&
                row(`gl-${ns.path}-cost-min`, 'warning', `Compute (${fmt(cost.overMinutes)} min over)`, `$${cost.compute}`, 'once')}
              {cost.storage > 0 &&
                row(
                  `gl-${ns.path}-cost-storage`,
                  'warning',
                  `Repo + LFS (${bytes(cost.billableBytes)} of ${bytes(cost.includedBytes)})`,
                  `$${cost.storage}`,
                  '/ yr',
                )}
            </Box>
          )}
        </Box>,
        compute,
      )
    })

    const adoErrors = errorsOf('ADO')
    const hosted =
      snap.ado &&
      usage('ado-min', { label: 'Hosted', used: snap.ado.hostedMinutesUsed, total: snap.ado.hostedMinutesTotal }, 'min')
    const adoCard = card(
      'ado',
      'Azure DevOps',
      config.org || 'off',
      <Box flexDirection="column">
        {!config.org && (
          <Text dimColor size="footnote">
            Set the ADO organization in the mod's settings.
          </Text>
        )}
        {config.org && !snap.ado && adoErrors.length === 0 && (
          <Text dimColor size="footnote">
            Not loaded yet.
          </Text>
        )}
        {hosted}
        {snap.ado && (
          <Box flexDirection="column">
            {meterRow('ado-hosted', 'Hosted parallel jobs', snap.ado.hostedJobsUsed, snap.ado.hostedJobsTotal)}
            {meterRow('ado-self', 'Self-hosted jobs', snap.ado.selfHostedJobsUsed, snap.ado.selfHostedJobsTotal)}
            {snap.ado.licenses.map(one => meterRow(`ado-lic-${one.name}`, one.name, one.assigned, one.total))}
          </Box>
        )}
        {snap.prs && reviewRow('ado-prs', 'Pull requests', snap.prs.listUrl, snap.prs.open, snap.prs.awaiting.length)}
        {[...adoErrors, ...errorsOf('PRs')].map(error => (
          <Text color="error" size="caption">
            {error}
          </Text>
        ))}
      </Box>,
      hosted || undefined,
    )

    return (
      <Box flexDirection="column">
        {showRow}
        {snap.gitlab.length === 0 &&
          card('gl-empty', 'GitLab', '', <Text dimColor>{snap.isRefreshing ? 'Loading…' : 'No namespaces loaded yet.'}</Text>)}
        {gitlabCards}
        {errorsOf('GitLab').map(error => (
          <Text color="error" size="footnote">
            GitLab: {error}
          </Text>
        ))}
        {!off.includes('ado') && adoCard}
        {errorsOf('MRs').map(error => (
          <Text color="error" size="caption">
            Merge requests: {error}
          </Text>
        ))}
        <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
          <Text dimColor size="caption">
            {snap.isRefreshing ? 'Refreshing…' : snap.updatedAt ? `Updated ${clock(snap.updatedAt)}` : ''}
          </Text>
          <Button key="refresh" label="Refresh" dimColor onPress={() => refresh($)} />
        </Box>
      </Box>
    )
  })
}

function meters(snap: Snapshot, off: string[] = []): Meter[] {
  const list: Meter[] = snap.gitlab.filter(ns => !off.includes(`gitlab:${ns.path}`)).map(ns => ({
    label: `GitLab ${ns.path} minutes`,
    used: ns.minutesUsed,
    total: ns.minutesQuota,
  }))
  if (snap.ado && snap.ado.hostedMinutesTotal > 0 && !off.includes('ado')) {
    list.push({ label: `ADO ${snap.ado.org} minutes`, used: snap.ado.hostedMinutesUsed, total: snap.ado.hostedMinutesTotal })
  }

  return list
}

const GIB = 1024 ** 3

// GitLab.com list prices: compute minutes at $10 per 1,000, one-off; storage
// at $5 a month per 10 GiB, billed yearly, for Git repository and LFS only.
// The included storage is per project (10 GiB Free, 500 GiB paid); the
// namespace's total stands in for its largest project, so this errs high.
function costOf(ns: GitlabNamespace) {
  const overMinutes = Math.max(0, ns.minutesUsed - ns.minutesQuota)
  const billableBytes = ns.repositoryBytes + ns.lfsBytes
  const includedBytes = (ns.plan === 'free' ? 10 : 500) * GIB
  const overBytes = Math.max(0, billableBytes - includedBytes)

  return {
    overMinutes,
    compute: Math.ceil(overMinutes / 1000) * 10,
    billableBytes,
    includedBytes,
    storage: Math.ceil(overBytes / (10 * GIB)) * 60,
  }
}

function ratio(one: Meter): number {
  return one.total > 0 ? one.used / one.total : 0
}

function percent(one: Meter): number {
  return Math.round(ratio(one) * 100)
}

function tone(one: Meter): string {
  const pct = ratio(one) * 100
  return pct >= 100 ? 'error' : pct >= config.warnAt ? 'warning' : 'success'
}

function fmt(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))
}

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
