/**
 * Normalize a Mongo connection string so performance/reliability defaults are
 * explicit (mirrors sdk-db `normalizeMongoUrl`):
 *  - retryWrites=false unless already set (keeps semantics predictable)
 *  - w=1 unless another write concern is present
 *  - directConnection=true ONLY for single-host, non-replica-set,
 *    non-SRV URIs (`mongodb+srv` implies replica-set discovery — appending
 *    `directConnection` there makes the driver reject the URI)
 *
 * Parsing is manual (string split + URLSearchParams) instead of WHATWG `new
 * URL`: the URL parser rejects multi-host seed lists (`h1:27017,h2:27017` —
 * it reads `,h2` as a port) and re-encodes userinfo/path in surprising ways.
 */
export const normalizeMongoUrl = (rawUrl: string): string => {
  try {
    const qIndex = rawUrl.indexOf('?');
    const base = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const query = qIndex === -1 ? '' : rawUrl.slice(qIndex + 1);
    const params = new URLSearchParams(query);

    if (!params.has('retryWrites')) params.set('retryWrites', 'false');
    const hasWriteConcern =
      params.has('w') || params.has('wtimeoutMS') || params.has('writeConcern');
    if (!hasWriteConcern) params.set('w', '1');

    // Hosts live between '://' and the first '/' (userinfo may precede them,
    // separated by the LAST '@'). Commas separate seed-list members.
    const schemeSep = base.indexOf('://');
    const authority = schemeSep === -1 ? base : (base.slice(schemeSep + 3).split('/')[0] ?? '');
    const hostPart = authority.includes('@') ? (authority.split('@').pop() ?? '') : authority;
    const hostCount = hostPart === '' ? 0 : hostPart.split(',').length;
    const isSrv = base.startsWith('mongodb+srv://');
    if (!isSrv && hostCount === 1 && !params.has('replicaSet') && !params.has('directConnection')) {
      params.set('directConnection', 'true');
    }

    const queryString = params.toString();
    return queryString ? `${base}?${queryString}` : base;
  } catch {
    return rawUrl;
  }
};
