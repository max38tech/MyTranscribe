// Single seam between the template scripts and the `gh` / `git` binaries.
// Every gh()/git() call any script makes is built on run(), so a test can
// substitute one fake runner and the script never spawns a real process,
// touches the network, or touches a real repository.
//
// Deliberately no retry/backoff here (SPEC.md section 2 forbids retry
// infrastructure for Level 1): a failing invocation throws once and the
// caller decides what "fail safely" means for that step.

import { execFileSync } from 'node:child_process';

export function defaultRun(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
}

// createExec(run) returns the gh/git/ghJson helpers the scripts actually
// call. run defaults to defaultRun (a real child_process invocation); tests
// pass a fake (args) => string instead, so nothing real ever gets spawned.
export function createExec(run = defaultRun) {
  return {
    run,
    gh: (args, opts) => run('gh', args, opts),
    ghJson: (args, opts) => JSON.parse(run('gh', args, opts)),
    git: (args, opts) => run('git', args, opts),
  };
}
