import type { HttpResponse } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'devops-consumption',
  component: 'Pane',
  requestId: 'devops-consumption',
  props: {
    title: 'GitLab & ADO consumption',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function out(stdout: unknown) {
  return {
    value: { exitCode: 0, stdout: JSON.stringify(stdout), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }
}

// The ADO org and the vault secret are blank by default; the tests set them.
const OPTIONS = { options: { adoOrg: 'contoso', adoPatSecret: 'team-vault/ado-pat' } }

test('the pane shows GitLab and ADO meters, on every surface', OPTIONS, async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'consumption' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('top_level_only')) {
      return out([{ id: 7, full_path: 'acme-platform', kind: 'group' }])
    }
    if (argv.includes('namespaces/7')) {
      return out({ plan: 'ultimate', ci_minutes_usage: { monthly_minutes_used: 45000 }, seats_in_use: 3, max_seats_used: 4 })
    }
    if (argv.includes('keyvault secret show --vault-name team-vault --name ado-pat')) {
      return out('test-pat')
    }
    if (argv.endsWith('api user')) {
      return out({ username: 'dev-user' })
    }
    if (argv.includes('reviewer_username=dev-user')) {
      return out([
        {
          iid: 12,
          title: 'feat: awards judging',
          web_url: 'https://gitlab.com/acme-platform/portal/-/merge_requests/12',
          references: { full: 'acme-platform/portal!12' },
          author: { username: 'sam' },
        },
        {
          iid: 3,
          title: 'untracked group',
          web_url: 'https://gitlab.com/elsewhere/x/-/merge_requests/3',
          references: { full: 'elsewhere/x!3' },
          author: { username: 'kim' },
        },
      ])
    }
    if (argv.includes('graphql')) {
      return out({
        data: {
          namespace: {
            actualRepositorySizeLimit: 1,
            rootStorageStatistics: {
              storageSize: 2 * 1024 ** 3,
              repositorySize: 1024 ** 2,
              lfsObjectsSize: 0,
              buildArtifactsSize: 0,
              containerRegistrySize: 1024 ** 3,
            },
          },
          group: { mergeRequests: { count: 140 } },
        },
      })
    }

    return out({ accessToken: 'test-token', expires_on: 9999999999 })
  })
  on('http.fetch', (_, e): { value: HttpResponse } => {
    // The PAT read from Key Vault rides as Basic auth.
    expect(e.init?.headers?.Authorization).toBe(`Basic ${btoa(':"test-pat"')}`)
    const reply = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (e.url.includes('connectionData')) {
      return reply({ authenticatedUser: { id: 'me-1' } })
    }
    if (e.url.includes('reviewerId=me-1')) {
      const pr = (id: number, vote: number) => ({
        pullRequestId: id,
        title: `PR ${id}`,
        createdBy: { displayName: 'Ana' },
        repository: { name: 'api', project: { name: 'Core App' } },
        reviewers: [{ id: 'me-1', vote }],
      })
      // 7 still waits on the person; 8 they already approved.
      return reply({ value: [pr(7, 0), pr(8, 10)] })
    }
    if (e.url.includes('pullrequests')) {
      return reply({ value: [{}, {}, {}] })
    }
    const body = e.url.includes('userentitlementsummary')
      ? {
          licenses: [
            { licenseName: 'Basic', assigned: 4, total: 5 },
            { licenseName: 'Stakeholder', assigned: 0, total: 2147483647 },
          ],
        }
      : { usedMinutes: 900, usedCount: 1, resourceLimit: { totalMinutes: 1800, totalCount: 1 } }

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ key: 'fold-gl-acme-platform' }))?.text).toBe('GitLab · acme-platform ▾')
    expect((await ui.find({ type: 'Text', text: /^90% used$/ }))?.text).toBe('90% used')
    expect((await ui.find({ type: 'Text', text: /^50% used$/ }))?.text).toBe('50% used')
    expect((await ui.find({ type: 'Text', text: /Container registry/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^50\.0%$/ }))?.text).toBe('50.0%')
    expect((await ui.find({ type: 'Text', text: /4 \/ 5/ }))?.text).toBe('4 / 5')
    // ADO's int32 "no limit" is not drawn as a total.
    expect(await ui.find({ type: 'Text', text: /2147483/ })).toBeFalsy()

    // Under quota and storage: no cost section at all.
    expect(await ui.find({ type: 'Text', text: /Extra cost/ })).toBeFalsy()

    // Review summaries sit in the cards: the group's open MRs and the one
    // awaiting the person (not the untracked group's); the org's open PRs and
    // the one still unvoted.
    expect((await ui.find({ type: 'Text', text: /^140 open$/ }))?.text).toBe('140 open')
    expect((await ui.find({ type: 'Text', text: /^3 open$/ }))?.text).toBe('3 open')
    expect((await ui.find({ type: 'Text', text: /^1 you$/ }))?.text).toBe('1 you')
    expect(await ui.find({ type: 'Text', text: /^2 you$/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /awaiting your review/ })).toBeFalsy()

    // The picker starts folded; opened, unticking a group hides its card and
    // ticking it again brings it back.
    expect(await ui.find({ key: 'show-gitlab:acme-platform' })).toBeFalsy()
    await ui.press({ key: 'groups' })
    await ui.press({ key: 'show-gitlab:acme-platform' })
    expect((await ui.find({ key: 'groups' }))?.text).toContain('1 of 2')
    expect(await ui.find({ key: 'fold-gl-acme-platform' })).toBeFalsy()
    expect((await ui.find({ type: 'Text', text: /^50% used$/ }))?.text).toBe('50% used')
    await ui.press({ key: 'show-gitlab:acme-platform' })
    expect((await ui.find({ key: 'fold-gl-acme-platform' }))?.text).toBe('GitLab · acme-platform ▾')
    await ui.press({ key: 'groups' })

    // Folding a card keeps its main meter and drops the rest; unfolding brings
    // the rest back.
    await ui.press({ key: 'fold-gl-acme-platform' })
    expect((await ui.find({ key: 'fold-gl-acme-platform' }))?.text).toBe('GitLab · acme-platform ▸')
    expect((await ui.find({ type: 'Text', text: /^90% used$/ }))?.text).toBe('90% used')
    expect(await ui.find({ type: 'Text', text: /Container registry/ })).toBeFalsy()
    await ui.press({ key: 'fold-gl-acme-platform' })
    expect(await ui.find({ type: 'Text', text: /Container registry/ })).toBeTruthy()
    await ui.unmount()  }
})

test('a group unticked in an earlier session stays hidden', OPTIONS, async ($, on) => {
  mock.clock(on)
  mock.store(on, { hidden: ['ado'] })
  on('command.register', () => ({ value: { command: 'consumption' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => out([]))
  on('http.fetch', (): { value: HttpResponse } => ({ value: { status: 200, ok: true, headers: {}, text: '{}' } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ key: 'fold-ado' })).toBeFalsy()
  await ui.unmount()
})
