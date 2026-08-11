import { Octokit } from "octokit";

/**
 * GitHub API client — browser-safe.
 *
 * Reads token from Vite's `VITE_GITHUB_TOKEN` (exposed to the browser at build
 * time) or from `process.env.GITHUB_TOKEN` (Node / server / actions). When no
 * token is set the client still works for public repos, just with unauthenticated
 * rate limits (60 req/h). For auth'd rate limits (5k req/h) set a fine-grained
 * PAT with `public_repo` read access.
 */
function getToken(): string | undefined {
  const viteToken = (import.meta as unknown as { env?: Record<string, string> }).env
    ?.["VITE_GITHUB_TOKEN"];
  if (viteToken && viteToken.length > 0) return viteToken;
  try {
    const nodeToken = (globalThis as unknown as { process?: { env?: Record<string, string> } })
      .process?.env?.["GITHUB_TOKEN"];
    if (nodeToken && nodeToken.length > 0) return nodeToken;
  } catch {
    // no process in browser
  }
  return undefined;
}

export function createGithubClient(token?: string): Octokit {
  const auth = token ?? getToken();
  return new Octokit(auth ? { auth } : {});
}

export async function fetchRepoInfo(owner: string, repo: string, token?: string) {
  const octokit = createGithubClient(token);
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data;
}

export function hasGithubToken(): boolean {
  return getToken() !== undefined;
}
