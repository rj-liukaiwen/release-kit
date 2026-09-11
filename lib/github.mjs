export async function api(route, { method = 'GET', body } = {}) {
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Invalid API route');
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) { const error = new Error(`GitHub ${method} ${route}: ${response.status} ${data?.message}`); error.status = response.status; throw error; }
  return data;
}
export async function absent(route) {
  try { await api(route); } catch (e) { if (e.status === 404) return; throw e; }
  throw new Error(`Version already exists: ${route}. Use a new version; existing assets are never overwritten.`);
}
