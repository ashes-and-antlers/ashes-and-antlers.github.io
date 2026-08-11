import { useEffect, useState } from 'react';
import { fetchRepoInfo } from '../lib/github';

type RepoData = Awaited<ReturnType<typeof fetchRepoInfo>>;

interface Props {
  owner: string;
  repo: string;
}

export function RepoInfo({ owner, repo }: Props) {
  const [data, setData] = useState<RepoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const info = await fetchRepoInfo(owner, repo);
        if (!cancelled) setData(info);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  if (loading) {
    return (
      <div className="repo-info repo-info--loading" aria-live="polite">
        Loading repository…
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="repo-info repo-info--error" role="alert">
        Could not load GitHub data: {error}
      </div>
    );
  }

  if (data === null) return null;

  return (
    <div className="repo-info">
      <a className="repo-info__name" href={data.html_url} target="_blank" rel="noopener noreferrer">
        {data.full_name}
      </a>
      {data.description ? <p className="repo-info__desc">{data.description}</p> : null}
      <div className="repo-info__stats">
        <span title="Stars">★ {data.stargazers_count.toLocaleString()}</span>
        <span title="Forks">⑂ {data.forks_count.toLocaleString()}</span>
        <span title="Open issues">◯ {data.open_issues_count.toLocaleString()}</span>
      </div>
      {data.updated_at ? (
        <span className="repo-info__updated">
          Updated {new Date(data.updated_at).toLocaleDateString()}
        </span>
      ) : null}
    </div>
  );
}
