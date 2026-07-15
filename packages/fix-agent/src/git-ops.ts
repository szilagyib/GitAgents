import { execFileSync } from "child_process";

export function gitAddFiles(cwd: string, filePaths: string[]): void {
  if (filePaths.length === 0) return;
  execFileSync("git", ["add", "--", ...filePaths], { cwd, stdio: "inherit" });
}

export function gitCommit(cwd: string, message: string): void {
  execFileSync("git", ["commit", "-m", message], { cwd, stdio: "inherit" });
}

// Authenticates the push via a credential helper that reads the token
// from an env var. The token never appears in:
//   - .git/config (would happen with `git remote set-url <url-with-creds>`)
//   - process argv (would happen with `-c http.extraHeader=PRIVATE-TOKEN: <t>`)
//   - the push URL itself
// It is only in the child process's env, where it has to be at all so
// git's helper can read it. `ps` shows the helper-script template; the
// token value is only readable from /proc/<pid>/environ (same-user only).
//
// We also pre-clean the runner-injected http.extraHeader from .git/config.
// In GitLab CI the runner populates it with the CI_JOB_TOKEN's
// AUTHORIZATION header, and http.extraHeader is multi-valued, so an
// inherited entry can shadow our auth path.
export function gitPush(
  cwd: string,
  remoteUrl: string,
  branch: string,
  token: string
): void {
  try {
    execFileSync(
      "git",
      ["config", "--local", "--unset-all", "http.extraHeader"],
      { cwd, stdio: "ignore" }
    );
  } catch {
    // Exit code 5 means "no such section or key" — fine, nothing to clear.
  }
  const credentialHelper =
    `!f() { echo username=oauth2; echo "password=$GITAGENTS_PUSH_TOKEN"; }; f`;
  execFileSync(
    "git",
    [
      "-c", `credential.helper=${credentialHelper}`,
      "push", remoteUrl, `HEAD:${branch}`,
    ],
    {
      cwd,
      stdio: "inherit",
      env: { ...process.env, GITAGENTS_PUSH_TOKEN: token },
    }
  );
}
