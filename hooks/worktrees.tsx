// The sdd Worktrees page (/sdd-worktrees): every work item that still has a folder, one line per repo,
// with the live state of its worktree from repowatch's scan (.claude/repowatch/state.json). It only
// reads. Removing a worktree is repowatch's job (it shows the plan and asks first), or sdd's own
// `env.py remove` for a work item's folder; this page points there and never changes anything.
import type { EngineInterface, Register } from 'claude-code'

type On = Parameters<Register>[0]

import type { SddLiveState, SddSnapshot } from '../types'
import { phaseLabel, statusWord } from './view/model'
import { agoText, cleanupNote, conflictNote, counts, groupByItem, joinWorktrees, lineFacts, sortLines } from './view/worktrees'

const PANE = 'sdd-worktrees'
const snap = { plugin: 'sdd', key: 'snap' } as const
const selected = { plugin: 'sdd', key: 'selected' } as const
const stage = { plugin: 'sdd', key: 'stage' } as const
const doc = { plugin: 'sdd', key: 'doc' } as const
const place = { plugin: 'sdd', key: 'workspace' } as const
const live = { plugin: 'sdd', key: 'wtLive' } as const
const liveError = { plugin: 'sdd', key: 'wtError' } as const
const offset = { plugin: 'sdd', key: 'wtOffset' } as const

const COLORS = { urgent: '#c0503f', warn: '#c98a12', ok: '#3f9a63', dim: '#7b8794', work: '#4a7fc4' }
const REFRESH_MS = 30_000

let isOpen = false
let timerOn = false

/** Called from register.tsx's ui.close, the one place the plugin hooks it. */
export function worktreesPaneClosed(id: string): void {
  if (id === PANE) isOpen = false
}

/** Called from register.tsx's session.start, the one place the plugin hooks it. */
export async function registerWorktreesCommand($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'sdd-worktrees',
    description: 'Show every sdd work item that still has worktrees, with the live state of each (from repowatch)',
  })
}

type Live = { state: SddLiveState | null; why: string | null }

/** Reads repowatch's state file in the workspace. Missing = repowatch has not scanned yet. */
async function readLive($: EngineInterface, root: string | null): Promise<Live> {
  if (!root) return { state: null, why: 'No sdd workspace found from this folder.' }
  try {
    const parsed = JSON.parse(await $.fs.read(`${root}/.claude/repowatch/state.json`)) as SddLiveState
    return { state: parsed, why: null }
  } catch {
    return { state: null, why: 'repowatch has not scanned this workspace yet. It scans by itself once a minute; /repowatch scan does it now.' }
  }
}

/** Called from register.tsx: a plugin names one hooks module, so this page hangs off it. */
export function registerWorktrees(on: On): void {
  on('command.run', { command: 'sdd-worktrees' }, async ($, e) => {
    isOpen = true
    if (!timerOn) {
      timerOn = true
      $.clock.every(REFRESH_MS, () => {
        if (!isOpen) return
        void (async () => {
          const s = (await $.state.get(snap)).value ?? null
          const r = await readLive($, s?.root ?? null)
          await $.state.set(live, r.state)
          await $.state.set(liveError, r.why)
        })()
      })
    }
    await $.ui.open({ id: PANE, title: 'sdd worktrees', closeOnEscape: true, columns: 110 })
    const s = (await $.state.get(snap)).value ?? null
    const r = await readLive($, s?.root ?? null)
    await $.state.set(live, r.state)
    await $.state.set(liveError, r.why)
    await $.state.set(offset, 0)
    return { text: 'sdd worktrees opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s: SddSnapshot | null = (await $.state.get(snap)).value ?? null
    const liveState = (await $.state.get(live)).value ?? null
    const why = (await $.state.get(liveError)).value ?? null
    const from = (await $.state.get(offset)).value ?? 0
    const now = Math.floor(Date.now() / 1000)

    const reload = async () => {
      const r = await readLive($, s?.root ?? null)
      await $.state.set(live, r.state)
      await $.state.set(liveError, r.why)
    }
    const openItem = (id: number) => async () => {
      await $.state.set(selected, id)
      await $.state.set(stage, null)
      await $.state.set(doc, null)
      await $.ui.open({ id: 'sdd-view', title: `sdd ${id}`, closeOnEscape: true, columns: 100 })
    }

    const header = (
      <Box flexDirection="column">
        <Box>
          <Text bold>sdd worktrees  </Text>
          <Button key="reload" label="↻" onPress={reload} />
          <Text> </Text>
          <Button key="rw" label="Clean up in repowatch" onPress={() => $.prompt.fill({ text: '/repowatch worktrees' })} />
        </Box>
        {why && <Text color={COLORS.warn}>{why}</Text>}
      </Box>
    )

    if (!s) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>The work items have not been read yet. Open /sdd-view first.</Text>
        </Box>
      )
    }

    const lines = sortLines(joinWorktrees(s.items, liveState))
    const blocks = groupByItem(lines)
    const size = Math.max(2, Math.floor(((e.viewport?.rows ?? 30) - 8) / 3))
    const shown = blocks.slice(from, from + size)
    const c = counts(lines)

    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor>
          {c.items} work items · {c.worktrees} worktrees · {c.cleanup} to clean up · {c.conflicts} will conflict · {c.dirty} with uncommitted files
          {liveState ? ` · scanned ${agoText(liveState.generated, now).replace('last commit ', '')}` : ''}
        </Text>
        {blocks.length === 0 && <Text dimColor>No work item has a worktree folder.</Text>}
        {shown.map(b => {
          const flow = s.flows[b.item.flow]
          return (
            <Box key={`item-${b.item.id}`} flexDirection="column">
              <Box>
                <Button key={`open-${b.item.id}`} label={`${b.item.id}`} onPress={openItem(b.item.id)} />
                <Text>  {b.item.title.slice(0, 60)}  </Text>
                <Text color={b.item.progress?.status === 'waiting' ? COLORS.warn : COLORS.dim}>
                  {phaseLabel(flow, b.item) || 'not started'} · {statusWord(b.item)}
                </Text>
              </Box>
              {b.lines.map(l => {
                const note = cleanupNote(l)
                const clash = conflictNote(l)
                return (
                  <Box key={`${l.item.id}-${l.repo}`} flexDirection="column" marginLeft={4}>
                    <Text>{l.repo} · {l.branch}</Text>
                    <Text dimColor>  {lineFacts(l, now).join(' · ')}</Text>
                    {note && <Text color={COLORS.warn}>  {note}</Text>}
                    {clash && <Text color={COLORS.urgent}>  {clash}</Text>}
                  </Box>
                )
              })}
            </Box>
          )
        })}
        {blocks.length > size && (
          <Box>
            <Text dimColor>{from + 1}-{Math.min(blocks.length, from + size)} of {blocks.length}  </Text>
            {from > 0 && <Button key="prev" label="Prev" onPress={() => $.state.set(offset, Math.max(0, from - size))} />}
            <Text> </Text>
            {from + size < blocks.length && <Button key="next" label="Next" onPress={() => $.state.set(offset, from + size)} />}
          </Box>
        )}
      </Box>
    )
  })
}
