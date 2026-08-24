import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function text(value) {
  return String(value ?? "").trim();
}

async function git(args, cwd) {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 8000,
  });
  return text(result.stdout);
}

function parseStatusBranch(line) {
  const match = line.match(/^##\s+(.+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/);
  if (!match) return { branch: line.replace(/^##\s+/, "") || null };
  const tracking = match[2] || null;
  const counts = match[3] || "";
  const ahead = Number(counts.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(counts.match(/behind (\d+)/)?.[1] || 0);
  return {
    branch: match[1] || null,
    upstream: tracking,
    ahead,
    behind,
  };
}

function isGithubRemote(url) {
  try {
    const parsed = new URL(url.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, ""));
    return parsed.hostname.toLowerCase() === "github.com";
  } catch {
    return /github\.com[:/]/i.test(url);
  }
}

export async function inspectGithubWorkspace({ cwd = process.cwd() } = {}) {
  const requestedCwd = text(cwd) || process.cwd();
  let root;
  try {
    root = await git(["rev-parse", "--show-toplevel"], requestedCwd);
  } catch (error) {
    return {
      ok: false,
      state: "not_a_git_repository",
      cwd: requestedCwd,
      message: `当前目录不是 Git 工作区：${String(error?.stderr || error)}`,
      read_only: true,
    };
  }
  try {
    const [statusOutput, remoteOutput, branch, head] = await Promise.all([
      git(["status", "--short", "--branch"], root),
      git(["remote", "-v"], root).catch(() => ""),
      git(["branch", "--show-current"], root),
      git(["rev-parse", "--short", "HEAD"], root),
    ]);
    const lines = statusOutput.split(/\r?\n/).filter(Boolean);
    const branchInfo = parseStatusBranch(lines.shift() || `## ${branch}`);
    const changes = lines.map(line => ({
      code: line.slice(0, 2),
      path: line.slice(3).trim(),
    }));
    const remotes = remoteOutput.split(/\r?\n/).filter(Boolean).map(line => {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      return match ? { name: match[1], url: match[2], direction: match[3] } : null;
    }).filter(Boolean);
    const githubRemotes = remotes.filter(remote => isGithubRemote(remote.url));
    return {
      ok: true,
      state: changes.length ? "changes_present" : "clean",
      read_only: true,
      repository: {
        root,
        name: root.split(/[\\/]/).filter(Boolean).at(-1) || root,
        github: githubRemotes.length > 0,
      },
      branch: branchInfo.branch || branch || null,
      upstream: branchInfo.upstream || null,
      ahead: branchInfo.ahead || 0,
      behind: branchInfo.behind || 0,
      head: head || null,
      remotes,
      github_remotes: githubRemotes,
      changes,
      checked_at: new Date().toISOString(),
      next_safe_actions: [
        "把本摘要作为网页大脑的工作区上下文",
        "让 Codex 在本地执行改动并运行测试",
        "提交、推送或拉取前由用户明确确认",
      ],
    };
  } catch (error) {
    return {
      ok: false,
      state: "git_inspection_failed",
      cwd: root,
      message: String(error),
      read_only: true,
    };
  }
}
