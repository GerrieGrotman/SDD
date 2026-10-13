# Regression test integrity

The regression test is the deliverable that outlives the fix. It has one job: **fail if this defect
ever comes back.** A test that would have passed before the fix does not do that job.

## Where the test goes

**Derive the test projects from the repo you are fixing. Never carry a list from another repo.**

```bash
git ls-files '*.csproj' | grep -iE 'test|spec'
```

Read the result:

| Project name | What it is | Use it for |
| --- | --- | --- |
| `*.{Layer}.UnitTest` | the unit tests for one layer | the regression test |
| `*.ArchUnitTest` | NetArchTest layer-boundary rules | never edit it — it must stay green |
| `*.IntegrationTest`, `*LoadTests` | slower, or not a test project at all | not the regression test |

The common shape is `{Solution}.{Layer}.UnitTest`, one project per layer. Some repos cover fewer
layers, and some have no test project at all. Check. Do not assume.

In a **UI repo** there are no `.csproj` files. Look for `*.test.ts` or `*.test.tsx` beside the source
file, and read `package.json` for the test runner and its script name.

Put the test in the project matching the layer that holds the cause. A defect in a service goes in
the Application unit tests, not in a Presentation test that reaches it through three layers.

**No unit-test project for the layer you need?** Say so at the approval gate rather than inventing
a project or shoving the test somewhere unrelated. Adding a test project is a scope change.

## Frameworks available

**Read what the repo already uses. Never add a package so you can write a test.** Open the test
project's `.csproj` and look at its `PackageReference` entries.

Common in these repos: xUnit with `xunit.runner.visualstudio`, **Moq** for fakes, and
NetArchTest.Rules in the ArchUnit project.

**FluentAssertions is usually absent.** Check before you reach for it. Fall back to `Assert.Equal`,
`Assert.Throws` and the rest of the xUnit set.

## Naming

Files: `{ClassUnderTest}Tests.cs` — `BillingLedgerServiceTests.cs`, `ChatServiceTests.cs`.

Methods: `{Method}_{ExpectedBehaviour}_{Condition}`, and the house style already leans on a
`_Not{WrongBehaviour}` suffix that names the defect directly — ideal for a regression test:

```
GetExternalUsageAsync_QueriesUsageThroughFirstDayOfNextMonth_NotLastDayOfBillingMonth
GetExternalUsageAsync_DoesNotLeakIntoNextDay_WhenBillingClosedMidMonthWithEndOfDayTimestamp
ProcessChatMessageAsync_FallsBackToOrganisationDefault_WhenAgentKeyEmptyAndNoAssistantChats
```

Name the test after the *defect*, so a future failure explains itself. Reference the work item in
an XML comment or a short `//` comment above it, not in the method name.

## The red → green → revert protocol

All of it runs **inside the worktree** (`<workspace root>\.claude\worktrees\{id}-{slug}\src\{Repo}`),
never in the main checkout. A fresh worktree has no `bin/`/`obj/`, so the first run is a cold build — don't
pass `--no-build` until something has been built at least once.

### 1. Red (Phase 7, before the fix)

```bash
dotnet test <solution> --filter "FullyQualifiedName~<TestName>"
```

It must fail. **Read the failure output** and confirm it is an *assertion* failure with a sensible
expected-vs-actual. These mean the test is broken, not the code, and must be fixed first:

- `NullReferenceException` — an unconfigured Moq dependency, not the defect
- compile error — obviously
- `Unable to resolve service for type…` — missing DI/fixture setup
- `Moq.MockException: … invocation failed with mock behavior Strict`
- the test passes — you have not encoded the defect at all; the assertion is wrong or too weak

Save the failure message verbatim. It goes in the PR.

### 2. Green (Phase 9)

Same command after the fix. It must pass.

### 3. Revert-check — the one that catches tautologies

Undo **only the source fix**, keeping the test, and re-run. The test must go red again. One command
does it and records the result:

```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py revert-check --id <id> --fix <source file> [--fix ...] \
  -- dotnet test <solution> --filter "FullyQualifiedName~<TestName>"
```

Name the *source* files of the fix with `--fix`, never the test — a check that also reverts the test
is meaningless. The script puts those files back to the base branch, runs the test (must FAIL),
restores them byte for byte with fresh time stamps (so an incremental build cannot reuse the
reverted build), and runs it again (must PASS). This works whether the fix is committed or not. If
the test still passes without the fix, it is not guarding the defect; rewrite it.

## Flakiness

### The repeat run

xUnit 2.x has no `--repeat-until-failure`, so loop it. Any variation across runs means flaky:

```powershell
1..5 | ForEach-Object {
  dotnet test <solution> --filter "FullyQualifiedName~<TestName>" --no-build |
    Select-String -Pattern 'Passed!|Failed!'
}
```

Then run the **whole** affected project once more — a test that passes in isolation but fails in the
suite is the classic shared-state flake, and the filter run would never show it.

### Causes to rule out before declaring it stable

| Smell | Why it flakes | Do instead |
| --- | --- | --- |
| `DateTime.Now` / `UtcNow` | midnight, month-end, DST, CI in another zone | inject the clock or pass explicit dates |
| `Guid.NewGuid()` in an assertion | value differs per run | fixed GUID constants |
| `Random` without a seed | different path per run | fixed seed |
| `Task.Delay` / `Thread.Sleep` to sequence | timing-dependent on a loaded agent | await the actual task; assert on state, not elapsed time |
| real DB, HTTP, or file system | shared UAT data, network, ordering | Moq the interface |
| `static` mutable state, or a `[Collection]` fixture | xUnit runs test *classes* in parallel — another class mutates it mid-run | per-test instances; no statics |
| depends on another test having run | execution order is not guaranteed | make each test self-contained |
| culture-sensitive parsing/formatting | agent locale differs | `CultureInfo.InvariantCulture` |
| asserts on collection order from an unordered source | dictionary/EF ordering is not stable | order explicitly, or assert set-wise |

### Concurrency defects need honesty

Some real defects are races. One real example: two users pulled the same chat at the same moment. A
test for a race is *inherently* timing-dependent, and looping it 5× proves little. Say so at the
approval gate: prefer restructuring the test to assert the guard directly (e.g. that the
check-before-assign call happens) over trying to reproduce the interleaving.

## Full suite

```bash
dotnet test <solution>
```

Runs unit + ArchUnit projects and skips `LoadTests/` (a console app). ArchUnit failures mean a
layer-boundary violation in your fix — they surface at **test** time, not compile time, so a green
build says nothing about them.

Pre-existing unrelated failures: explain each one and ask the user whether to fix it here — see
"Bugs this work did not cause" in `${CLAUDE_PLUGIN_ROOT}/skills/sdd/references/flow-rules.md`.
Never fold one into your fix without the user's yes, and don't claim the suite is green when it
isn't. `NU190x` package-vulnerability warnings are
pre-existing noise and not caused by your change.
