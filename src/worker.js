/**
 * r2book — 私人书库 Worker
 *
 * 定位：R2 当仓库，Worker 当「协议适配器 + 鉴权门」。零依赖、不开 nodejs_compat。
 *
 * 读取路径（Readingo 拉取）只做三件事：校验身份 → 读分类级元数据 → 渲染 XML / 代理下载。
 * 元数据按分类分片，所以单次请求解析的数据量与书库总量无关。
 *
 * R2 结构：
 *   _meta/root.json          分类清单 + 每类的 count/bytes（冗余，避免读全部分片）
 *   _meta/cat/<slug>.json    单个分类的书目
 *   books/<slug>/<file>      正文
 *   _trash/<ts>/<file>       软删除暂存
 */

const META_ROOT = '_meta/root.json';
const metaCat = (slug) => `_meta/cat/${slug}.json`;
const bookKey = (slug, file) => `books/${slug}/${file}`;
const trashKey = (ts, slug, file) => `_trash/${ts}/${slug}/${file}`; // slug 防不同分类同名书碰撞覆盖
const BACKUP_PREFIX = 'backup/';
const DEFAULT_SITE = '私人书库';

/* Readingo 进度备份区：进/出的防护线（进度 JSON 很小，够用） */
const BACKUP_MAX_DEFAULT = 5 * 1024 * 1024; // 单文件 5MB
const BACKUP_MAX_ITEMS = 300; // 条目数上限，防客户端 bug 刷爆 10GB

/* ---------------- 基础工具 ---------------- */

const nowRfc1123 = (ms) => new Date(ms).toUTCString();

/* 列表统一排序：WebDAV / OPDS / 管理页三类出口共用，书名升序（中文按拼音、数字按数值），
 * 让手机上看到的书架顺序与管理页一致 */
const zhCollator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });
const sortBooks = (books) =>
  (books || [])
    .slice()
    .sort((a, b) => zhCollator.compare(String(a.title || a.file), String(b.title || b.file)));

const xmlEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** 路径逐段编码，保留分隔符，中文文件名安全 */
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** URL.pathname 保留百分号编码，逐段解码还原真实文件名；畸形编码原样返回 */
const decSeg = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const decodeSegs = (p) => p.replace(/\/+$/, '').split('/').filter(Boolean).map(decSeg);

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const xml = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' } });

const notFound = () => new Response('Not Found', { status: 404 });

const unauthorized = (withChallenge) =>
  new Response('Unauthorized', {
    status: 401,
    headers: withChallenge ? { 'WWW-Authenticate': 'Basic realm="Private", charset="UTF-8"' } : {},
  });

/** 去掉路径分隔符、HTML 敏感字符与前置点：既防 R2 key 穿越，也防 slug/file
 * 被内插进前端 HTML 属性（value="..."）形成存储型注入 */
const safeSeg = (s) =>
  String(s || '')
    .replace(/[\u0000-\u001f\u007f<>"'`\\/]/g, '')
    .replace(/^\.+/, '')
    .trim();

const titleOf = (file) => String(file).replace(/\.[^.]+$/, '').trim();

function contentType(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  const map = {
    txt: 'text/plain; charset=utf-8',
    text: 'text/plain; charset=utf-8',
    epub: 'application/epub+zip',
    pdf: 'application/pdf',
    mobi: 'application/x-mobipocket-ebook',
    azw3: 'application/vnd.amazon.ebook',
    zip: 'application/zip',
    md: 'text/markdown; charset=utf-8',
    html: 'text/html; charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b + '==='.slice((b.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 常量时间比较，避免通过响应时间侧信道逐字节猜密码 */
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---- 暴力破解防护（尽力而为，纯内存，不产生额外请求） ----
 * Workers 无服务器，内存 Map 只在单个 isolate 生命周期内持续、不做跨 isolate 共享，
 * 所以这是把单 IP 弱口令爆破成本抬高到「基本不可行」的近似防护，而非精确计数。
 * 两个独立作用域：dav（WebDAV/OPDS 的 Basic Auth）与 login（上传端登录）。
 * 连错 BRUTE_LIMIT 次锁定 BRUTE_LOCK_MS（默认 5 次 / 10 分钟），
 * 可用环境变量 BRUTE_LIMIT / BRUTE_LOCK_MS 覆盖。
 */
const BRUTE = new Map();
const BRUTE_MAX = 10000; // 防攻击者轮换 IP 把 Map 撑爆内存
/** Map 超限时先清已过期条目，仍超再逐出「最早锁定」的一个 */
const brutePrune = () => {
  if (BRUTE.size < BRUTE_MAX) return;
  const now = Date.now();
  for (const [k, rec] of BRUTE) {
    if (rec.until <= now) BRUTE.delete(k);
    if (BRUTE.size < BRUTE_MAX) break;
  }
  let oldestKey = null;
  let oldest = Infinity;
  for (const [k, rec] of BRUTE) {
    if (rec.until < oldest) {
      oldest = rec.until;
      oldestKey = k;
    }
  }
  if (oldestKey) BRUTE.delete(oldestKey);
};
const bruteCfg = (env) => ({
  limit: Number(env.BRUTE_LIMIT) || 5,
  lockMs: Number(env.BRUTE_LOCK_MS) || 10 * 60 * 1000,
});
const clientIp = (req) => req.headers.get('CF-Connecting-IP') || 'unknown'; // 只信 CF 注入头，xff 可伪造
const bruteKey = (scope, ip) => `${scope}:${ip}`;
const bruteLocked = (req, env, scope) => {
  const rec = BRUTE.get(bruteKey(scope, clientIp(req)));
  return !!rec && rec.until > Date.now();
};
const bruteFail = (req, env, scope) => {
  brutePrune();
  const cfg = bruteCfg(env);
  const key = bruteKey(scope, clientIp(req));
  const now = Date.now();
  const rec = BRUTE.get(key) || { fail: 0, until: 0 };
  // 只有「曾经锁定且已过期」才重置计数；否则（未锁定状态）直接累加，
  // 否则 fail 每次都被归零，永远到不了阈值，防护等于没装
  if (rec.until > 0 && rec.until <= now) {
    rec.fail = 0;
    rec.until = 0;
  }
  rec.fail += 1;
  if (rec.fail >= cfg.limit) {
    rec.until = now + cfg.lockMs;
    rec.fail = 0;
  }
  BRUTE.set(key, rec);
};
const bruteClear = (req, env, scope) => BRUTE.delete(bruteKey(scope, clientIp(req)));

/* ---------------- 鉴权 ---------------- */

/** 上传端：HMAC 签名的无状态 Cookie */
async function verifyCookie(req, env) {
  const cookie = req.headers.get('Cookie') || '';
  const m = /(?:^|;\s*)rb_session=([^;]+)/.exec(cookie);
  if (!m) return false;
  const token = m[1];
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const secret = env.SESSION_SECRET || env.ADMIN_PASSWORD;
  if (!secret) return false;
  if (!safeEqual(sig, await hmac(secret, payload))) return false;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

/** Readingo：Basic Auth。用户名任意，密码用 DAV_PASSWORD（未设则回退主口令） */
function verifyBasic(req, env) {
  const h = req.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let dec;
  try {
    dec = atob(h.slice(6));
  } catch {
    return false;
  }
  const i = dec.indexOf(':');
  if (i < 0) return false;
  const expected = env.DAV_PASSWORD || env.ADMIN_PASSWORD;
  return !!expected && safeEqual(dec.slice(i + 1), expected);
}

/* ---------------- 元数据读写 ---------------- */

async function readMeta(bucket, key, fallback) {
  const obj = await bucket.get(key);
  if (!obj) return { data: fallback, etag: null };
  try {
    return { data: JSON.parse(await obj.text()), etag: obj.etag };
  } catch {
    return { data: fallback, etag: obj.etag };
  }
}

async function putMeta(bucket, key, data, etag) {
  const body = JSON.stringify(data);
  try {
    if (etag) await bucket.put(key, body, { onlyIf: { etagMatches: etag } });
    else await bucket.put(key, body);
    return true;
  } catch {
    return false;
  }
}

/**
 * 乐观锁重试的读改写。R2 没有事务，并发上传时用 etag 检测冲突并重试，
 * 避免「读—改—写」静默丢更新。
 */
async function updateMeta(bucket, key, fallback, fn, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const { data, etag } = await readMeta(bucket, key, fallback);
    const next = fn(data) || data;
    if (await putMeta(bucket, key, next, etag)) return next;
  }
  return null;
}

const updateCat = (env, slug, fn) => updateMeta(env.BUCKET, metaCat(slug), { name: slug, books: [] }, fn);

const updateRoot = (env, fn) => updateMeta(env.BUCKET, META_ROOT, { cats: [], updatedAt: 0 }, fn);

/** 用分片里的真实数据回写 root.json 的 count/bytes，省掉读全部分片 */
async function syncCatToRoot(env, slug, name) {
  const { data: cat } = await readMeta(env.BUCKET, metaCat(slug), { name: slug, books: [] });
  const books = cat.books || [];
  const bytes = books.reduce((s, b) => s + (Number(b.size) || 0), 0);
  const res = await updateRoot(env, (root) => {
    let c = root.cats.find((x) => x.slug === slug);
    if (!c) {
      c = { slug };
      root.cats.push(c);
    }
    if (name) c.name = name;
    if (!c.name) c.name = slug;
    c.count = books.length;
    c.bytes = bytes;
    root.updatedAt = Date.now();
    return root;
  });
  return !!res;
}

/* ---------------- WebDAV ----------------
 * /books/  只读子集（OPTIONS/PROPFIND/GET/HEAD）——书库永远不允许被客户端改写
 * /backup/ 可写（+PUT/MKCOL/DELETE）——Readingo 进度备份通道，带大小/条目防护
 */
const DAV_ALLOW = 'OPTIONS, PROPFIND, GET, HEAD';
const DAV_ALLOW_BACKUP = 'OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE';

function davOptions(zone = 'books') {
  return new Response(null, {
    status: 200,
    headers: {
      Allow: zone === 'backup' ? DAV_ALLOW_BACKUP : DAV_ALLOW,
      DAV: '1',
      'Accept-Ranges': 'bytes',
      'MS-Author-Via': 'DAV',
    },
  });
}

const davInfinity = () =>
  xml('<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:propfind-finite-depth-lock/></D:error>', 403);

function davEntry(href, opts) {
  const { name, mtime, isCollection, size, etag } = opts;
  const type = isCollection ? '<D:collection/>' : '';
  const sizeLine = isCollection ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`;
  const ctypeLine = isCollection ? '' : `<D:getcontenttype>${xmlEsc(opts.ctype)}</D:getcontenttype>`;
  return (
    `<D:response><D:href>${encPath(href)}</D:href><D:propstat><D:prop>` +
    `<D:displayname>${xmlEsc(name)}</D:displayname>` +
    `<D:resourcetype>${type}</D:resourcetype>` +
    sizeLine +
    ctypeLine +
    `<D:getlastmodified>${nowRfc1123(mtime)}</D:getlastmodified>` +
    `<D:getetag>"${xmlEsc(etag)}"</D:getetag>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

async function propfind(req, env, p) {
  const depth = (req.headers.get('Depth') || '1').toLowerCase();
  if (depth === 'infinity') return davInfinity();

  const segs = decodeSegs(p);
  const base = '/' + segs.join('/');
  const out = ['<?xml version="1.0" encoding="utf-8"?>', '<D:multistatus xmlns:D="DAV:">'];

  // 根：列出分类
  if (segs.length === 0 || (segs.length === 1 && segs[0] === 'books')) {
    const { data: root } = await readMeta(env.BUCKET, META_ROOT, { cats: [] });
    out.push(davEntry('/', { name: 'books', mtime: root.updatedAt || Date.now(), isCollection: true, etag: 'root' }));
    if (depth !== '0') {
      for (const c of root.cats || []) {
        out.push(
          davEntry(`/books/${c.slug}`, {
            name: c.name || c.slug,
            mtime: root.updatedAt || Date.now(),
            isCollection: true,
            etag: 'cat-' + c.slug,
          })
        );
      }
    }
    out.push('</D:multistatus>');
    return xml(out.join(''), 207);
  }

  // 分类：列出该类的书
  if (segs.length === 2 && segs[0] === 'books') {
    const slug = segs[1];
    const { data: cat } = await readMeta(env.BUCKET, metaCat(slug), null);
    if (!cat) return notFound();
    out.push(davEntry(base, { name: cat.name || slug, mtime: Date.now(), isCollection: true, etag: 'cat-' + slug }));
    if (depth !== '0') {
      for (const b of sortBooks(cat.books)) {
        out.push(
          davEntry(`/books/${slug}/${b.file}`, {
            name: b.title || b.file,
            mtime: b.mtime || Date.now(),
            isCollection: false,
            size: b.size || 0,
            ctype: contentType(b.file),
            etag: `${(b.size || 0).toString(16)}-${(b.mtime || 0).toString(16)}`,
          })
        );
      }
    }
    out.push('</D:multistatus>');
    return xml(out.join(''), 207);
  }

  // 单文件
  if (segs.length === 3 && segs[0] === 'books') {
    const [, slug, file] = segs;
    const { data: cat } = await readMeta(env.BUCKET, metaCat(slug), null);
    const b = cat && (cat.books || []).find((x) => x.file === file);
    if (!b) return notFound();
    out.push(
      davEntry(base, {
        name: b.title || b.file,
        mtime: b.mtime || Date.now(),
        isCollection: false,
        size: b.size || 0,
        ctype: contentType(b.file),
        etag: `${(b.size || 0).toString(16)}-${(b.mtime || 0).toString(16)}`,
      })
    );
    out.push('</D:multistatus>');
    return xml(out.join(''), 207);
  }

  return notFound();
}

function parseRange(h) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h).trim());
  if (!m) return 'invalid';
  const s = m[1];
  const e = m[2];
  if (s === '' && e === '') return 'invalid';
  if (s === '') return Number(e) > 0 ? { suffix: Number(e) } : 'invalid'; // bytes=-0 无意义
  if (e === '') return { offset: Number(s) };
  const start = Number(s);
  const end = Number(e);
  if (end < start) return 'invalid';
  return { offset: start, length: end - start + 1 };
}

async function getFile(req, env, p, head) {
  const segs = decodeSegs(p);
  if (segs.length !== 3 || segs[0] !== 'books') return notFound();
  const [, slug, file] = segs;

  const rangeHeader = req.headers.get('Range');
  let rangeOpt;
  if (rangeHeader) {
    rangeOpt = parseRange(rangeHeader);
    if (rangeOpt === 'invalid') return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */*' } });
  }

  const obj = rangeOpt ? await env.BUCKET.get(bookKey(slug, file), { range: rangeOpt }) : await env.BUCKET.get(bookKey(slug, file));
  if (!obj) return notFound();

  const headers = new Headers();
  headers.set('Content-Type', contentType(file));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', `"${obj.etag}"`);
  headers.set('Cache-Control', 'no-store'); // 私密书库：禁止浏览器缓存正文
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file)}`);

  let status = 200;
  if (rangeOpt) {
    // 片段响应需要总长度，从分片元数据取，避免额外一次 head
    const { data: cat } = await readMeta(env.BUCKET, metaCat(slug), { books: [] });
    const rec = (cat.books || []).find((x) => x.file === file);
    const total = rec ? Number(rec.size) || obj.size : obj.size;
    const start = rangeOpt.suffix ? Math.max(0, total - rangeOpt.suffix) : rangeOpt.offset || 0;
    if (start >= total) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    headers.set('Content-Range', `bytes ${start}-${start + obj.size - 1}/${total}`);
    headers.set('Content-Length', String(obj.size));
    status = 206;
  } else {
    headers.set('Content-Length', String(obj.size));
  }

  if (head) return new Response(null, { status, headers });
  return new Response(obj.body, { status, headers });
}

async function handleDav(req, env, p, zone = 'books') {
  const m = req.method;
  if (m === 'OPTIONS') return davOptions(zone);

  if (zone === 'backup') {
    const segs = decodeSegs(p);
    const rest = segs.slice(1).join('/');
    if (m === 'PROPFIND') return propfindBackup(req, env, depth(req));
    if (m === 'GET' || m === 'HEAD') return backupGet(req, env, rest, m === 'HEAD');
    if (m === 'PUT') return backupPut(req, env, rest);
    if (m === 'MKCOL') return rest ? new Response(null, { status: 201 }) : new Response(null, { status: 405 });
    if (m === 'DELETE') return backupDelete(env, rest);
    return new Response(null, { status: 405, headers: { Allow: DAV_ALLOW_BACKUP } });
  }

  if (m === 'PROPFIND') return propfind(req, env, p);
  if (m === 'GET' || m === 'HEAD') return getFile(req, env, p, m === 'HEAD');
  return new Response(null, { status: 405, headers: { Allow: DAV_ALLOW } });
}

/* ---- /backup/ 可写区实现 ---- */

const depth = (req) => (req.headers.get('Depth') || '1').toLowerCase();

async function propfindBackup(req, env, d) {
  if (d === 'infinity') return davInfinity();
  const listing = await env.BUCKET.list({ prefix: BACKUP_PREFIX });
  const out = ['<?xml version="1.0" encoding="utf-8"?>', '<D:multistatus xmlns:D="DAV:">'];
  out.push(davEntry('/backup', { name: 'backup', mtime: Date.now(), isCollection: true, etag: 'backup' }));
  if (d !== '0') {
    for (const o of listing.objects) {
      const name = o.key.slice(BACKUP_PREFIX.length);
      if (!name || name.endsWith('/')) continue;
      out.push(
        davEntry(`/backup/${name}`, {
          name,
          mtime: o.uploaded ? o.uploaded.getTime() : Date.now(),
          isCollection: false,
          size: o.size,
          ctype: contentType(name),
          etag: o.etag,
        })
      );
    }
  }
  out.push('</D:multistatus>');
  return xml(out.join(''), 207);
}

async function backupGet(req, env, rest, head) {
  if (!rest) return notFound();
  const obj = await env.BUCKET.get(BACKUP_PREFIX + rest);
  if (!obj) return notFound();
  const headers = new Headers({
    'Content-Type': contentType(rest),
    'Content-Length': String(obj.size),
    'ETag': `"${obj.etag}"`,
    'Cache-Control': 'no-store',
  });
  if (head) return new Response(null, { status: 200, headers });
  return new Response(obj.body, { status: 200, headers });
}

async function backupPut(req, env, rest) {
  if (!rest || rest.endsWith('/')) return json({ error: 'backup 路径不合法' }, 400);
  const max = Number(env.BACKUP_MAX || BACKUP_MAX_DEFAULT);
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > max) return json({ error: `备份文件超过上限 ${(max / 1048576) | 0}MB` }, 413);
  const body = await req.arrayBuffer();
  if (body.byteLength > max) return json({ error: `备份文件超过上限 ${(max / 1048576) | 0}MB` }, 413);
  // 条目数防护：只在新增时检查，覆盖写不占新名额
  const listing = await env.BUCKET.list({ prefix: BACKUP_PREFIX });
  const key = BACKUP_PREFIX + rest;
  const exists = listing.objects.some((o) => o.key === key);
  if (!exists && listing.objects.length >= BACKUP_MAX_ITEMS) return json({ error: '备份条目数已达上限' }, 507);
  await env.BUCKET.put(key, body);
  return new Response(null, { status: 201 });
}

async function backupDelete(env, rest) {
  if (!rest) return new Response(null, { status: 403 }); // 不允许删整个 backup 集合
  await env.BUCKET.delete(BACKUP_PREFIX + rest);
  return new Response(null, { status: 204 });
}

/* ---------------- OPDS ---------------- */

const ATOM_NS = 'xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog"';
const NAV_TYPE = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const ACQ_TYPE = 'application/atom+xml;profile=opds-catalog;kind=acquisition';

function feedHeader(origin, selfHref, title, kindType) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<feed ${ATOM_NS}>` +
    `<id>urn:r2book:${encPath(selfHref)}</id>` +
    `<title>${xmlEsc(title)}</title>` +
    `<updated>${new Date().toISOString()}</updated>` +
    `<author><name>r2book</name></author>` +
    `<link rel="self" href="${origin}${encPath(selfHref)}" type="${kindType}"/>` +
    `<link rel="start" href="${origin}/opds/" type="${NAV_TYPE}"/>` +
    `<link rel="search" href="${origin}/opds/opensearch.xml" type="application/opensearchdescription+xml"/>`
  );
}

function acqEntry(origin, slug, b) {
  const href = `${origin}${encPath('/books/' + slug + '/' + b.file)}`;
  const type = contentType(b.file);
  const size = Number(b.size) || 0;
  return (
    `<entry>` +
    `<id>urn:r2book:${encPath(slug + '/' + b.file)}</id>` +
    `<title>${xmlEsc(b.title || titleOf(b.file))}</title>` +
    `<updated>${new Date(b.mtime || Date.now()).toISOString()}</updated>` +
    `<dc:format>${xmlEsc(type)}</dc:format>` +
    (size ? `<dc:extent>${size}</dc:extent>` : '') +
    `<link rel="http://opds-spec.org/acquisition" href="${href}" type="${xmlEsc(type)}"/>` +
    `<link rel="http://opds-spec.org/acquisition/open-access" href="${href}" type="${xmlEsc(type)}"/>` +
    `</entry>`
  );
}

async function opdsRoot(req, env) {
  const origin = new URL(req.url).origin;
  const site = env.SITE_NAME || DEFAULT_SITE;
  const { data: root } = await readMeta(env.BUCKET, META_ROOT, { cats: [] });
  const out = [feedHeader(origin, '/opds/', site, NAV_TYPE)];
  for (const c of root.cats || []) {
    out.push(
      `<entry>` +
        `<id>urn:r2book:cat:${encPath(c.slug)}</id>` +
        `<title>${xmlEsc(c.name || c.slug)}</title>` +
        `<updated>${new Date(root.updatedAt || Date.now()).toISOString()}</updated>` +
        `<content type="text">${Number(c.count) || 0} 本</content>` +
        `<link rel="subsection" href="${origin}${encPath('/opds/' + c.slug + '.xml')}" type="${ACQ_TYPE}"/>` +
        `</entry>`
    );
  }
  out.push('</feed>');
  return xml(out.join(''));
}

/** 分类 feed 分页：OPDS 规范用 rel="first/previous/next/last" 链接翻页，
 * 大书架在 iOS Readingo 里也流畅；默认每页 100，可用 OPDS_PAGE_SIZE 调。 */
const OPDS_PAGE_SIZE = 100;

async function opdsCat(req, env, slug) {
  const origin = new URL(req.url).origin;
  const site = env.SITE_NAME || DEFAULT_SITE;
  const url = new URL(req.url);
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') || 1)) || 1);
  const { data: cat } = await readMeta(env.BUCKET, metaCat(slug), null);
  if (!cat) return notFound();
  const all = sortBooks(cat.books);
  const pages = Math.max(1, Math.ceil(all.length / OPDS_PAGE_SIZE));
  const cur = Math.min(page, pages); // 页码夹紧：越界落到最后一页，而不是返回空 feed
  const slice = all.slice((cur - 1) * OPDS_PAGE_SIZE, cur * OPDS_PAGE_SIZE);

  const out = [feedHeader(origin, `/opds/${slug}.xml`, `${site} · ${cat.name || slug}`, ACQ_TYPE)];
  const catRef = (n) => encPath(`/opds/${slug}.xml`) + `?page=${n}`;
  if (cur > 1) {
    out.push(`<link rel="first" href="${origin}${catRef(1)}" type="${ACQ_TYPE}"/>`);
    out.push(`<link rel="previous" href="${origin}${catRef(cur - 1)}" type="${ACQ_TYPE}"/>`);
  }
  if (cur < pages) out.push(`<link rel="next" href="${origin}${catRef(cur + 1)}" type="${ACQ_TYPE}"/>`);
  if (pages > 1) out.push(`<link rel="last" href="${origin}${catRef(pages)}" type="${ACQ_TYPE}"/>`);
  for (const b of slice) out.push(acqEntry(origin, slug, b));
  out.push('</feed>');
  return xml(out.join(''));
}

async function opdsSearch(req, env, q) {
  const origin = new URL(req.url).origin;
  const site = env.SITE_NAME || DEFAULT_SITE;
  const key = q.trim().toLowerCase();
  const out = [feedHeader(origin, '/opds/search.xml', `${site} · 搜索「${q}」`, ACQ_TYPE)];
  if (key) {
    const { data: root } = await readMeta(env.BUCKET, META_ROOT, { cats: [] });
    let hits = 0;
    let scanned = 0;
    // CPU 预算控制：搜索要解析分类 JSON（实测约 0.8ms/千本）。限「解析分类 ≤20
    // （subrequest root+20=21 有余量）且累计扫描本数 ≤10000（约 8ms）」，
    // 超出即止，避免顶到 Free 计划 10ms CPU 硬限——hits 只截输出、不省解析。
    for (const c of (root.cats || []).slice(0, 20)) {
      if (scanned >= 10000) break;
      const { data: cat } = await readMeta(env.BUCKET, metaCat(c.slug), { books: [] });
      scanned += (cat.books || []).length;
      for (const b of cat.books || []) {
        if (String(b.title || b.file).toLowerCase().includes(key)) {
          out.push(acqEntry(origin, c.slug, b));
          if (++hits >= 50) break;
        }
      }
    }
  }
  out.push('</feed>');
  return xml(out.join(''));
}

function opdsOpenSearch(req, env) {
  const origin = new URL(req.url).origin;
  const site = env.SITE_NAME || DEFAULT_SITE;
  return xml(
    '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">' +
      `<ShortName>${xmlEsc(site)}</ShortName>` +
      '<Description>搜索书名</Description>' +
      '<InputEncoding>UTF-8</InputEncoding>' +
      `<Url type="${ACQ_TYPE}" template="${origin}/opds/search.xml?q={searchTerms}"/>` +
      '</OpenSearchDescription>'
  );
}

async function handleOpds(req, env, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  if (p === '/opds' || p === '/opds/') return opdsRoot(req, env);
  if (p === '/opds/opensearch.xml') return opdsOpenSearch(req, env);
  if (p === '/opds/search.xml') return opdsSearch(req, env, new URL(req.url).searchParams.get('q') || '');
  const m = /^\/opds\/(.+)\.xml$/.exec(p);
  if (m) return opdsCat(req, env, safeSeg(decSeg(m[1])));
  return notFound();
}

/* ---------------- 管理 API ---------------- */

/** Cookie 属性。本地 wrangler dev 是 http，带 Secure 浏览器不会保存，故按协议判断 */
function cookieAttrs(req, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function apiLogin(req, env) {
  if (bruteLocked(req, env, 'login')) return new Response('Too Many Requests', { status: 429 });
  const body = await req.json().catch(() => ({}));
  const pass = String(body.password || '');
  const admin = env.ADMIN_PASSWORD;
  if (!admin) return json({ error: '口令错误' }, 401); // 配置缺失与口令错误同码，避免暴露部署状态
  if (!safeEqual(pass, admin)) {
    bruteFail(req, env, 'login');
    return json({ error: '口令错误' }, 401);
  }
  bruteClear(req, env, 'login');

  const days = Number(env.SESSION_DAYS || 30) || 30;
  const payload = b64url(JSON.stringify({ exp: Date.now() + days * 86400000 }));
  const sig = await hmac(env.SESSION_SECRET || admin, payload);
  return json({ ok: true }, 200, {
    'Set-Cookie': `rb_session=${payload}.${sig}; ${cookieAttrs(req, days * 86400)}`,
  });
}

const apiLogout = (req) => json({ ok: true }, 200, { 'Set-Cookie': `rb_session=; ${cookieAttrs(req, 0)}` });

async function apiState(env) {
  const { data: root } = await readMeta(env.BUCKET, META_ROOT, { cats: [] });
  const cats = root.cats || [];
  return json({
    site: env.SITE_NAME || DEFAULT_SITE,
    cats,
    totalBooks: cats.reduce((s, c) => s + (Number(c.count) || 0), 0),
    totalBytes: cats.reduce((s, c) => s + (Number(c.bytes) || 0), 0),
    maxUpload: Number(env.MAX_UPLOAD || 52428800),
  });
}

async function apiCatGet(env, slug) {
  const { data: cat } = await readMeta(env.BUCKET, metaCat(slug), null);
  if (!cat) return json({ error: '分类不存在' }, 404);
  return json({ slug, name: cat.name || slug, books: sortBooks(cat.books) });
}

async function apiCatUpsert(req, env) {
  const body = await req.json().catch(() => ({}));
  const slug = safeSeg(body.slug);
  const name = String(body.name || '').trim();
  if (!slug) return json({ error: '缺少 slug' }, 400);
  const ok = await updateCat(env, slug, (cat) => {
    cat.name = name || cat.name || slug;
    if (!Array.isArray(cat.books)) cat.books = [];
    return cat;
  });
  if (!ok) return json({ error: '索引写入冲突，请重试' }, 409);
  await syncCatToRoot(env, slug, name || undefined);
  return json({ ok: true, slug });
}

async function apiCatDelete(req, env) {
  const body = await req.json().catch(() => ({}));
  const slug = safeSeg(body.slug);
  const { data: cat } = await readMeta(env.BUCKET, metaCat(slug), { books: [] });
  if ((cat.books || []).length) return json({ error: '分类非空，请先移出或删除其中的书' }, 400);
  await env.BUCKET.delete(metaCat(slug));
  await updateRoot(env, (root) => {
    root.cats = (root.cats || []).filter((c) => c.slug !== slug);
    root.updatedAt = Date.now();
    return root;
  });
  return json({ ok: true });
}

async function apiUpload(req, env, url) {
  const slug = safeSeg(url.searchParams.get('cat'));
  const catName = (url.searchParams.get('catName') || '').trim();
  const file = safeSeg(url.searchParams.get('file'));
  const overwrite = url.searchParams.get('ow') === '1';
  if (!slug || !file) return json({ error: '缺少 cat 或 file 参数' }, 400);

  const max = Number(env.MAX_UPLOAD || 52428800);
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > max) return json({ error: `文件超过上限 ${(max / 1048576) | 0}MB` }, 413);

  // 同名查重：读分片元数据即可（1 次 subrequest），不查 R2 本体
  const { data: existing } = await readMeta(env.BUCKET, metaCat(slug), { books: [] });
  const dup = (existing.books || []).find((b) => b.file === file);
  if (dup && !overwrite) {
    return json({ error: '已存在同名书', exists: true, title: dup.title || titleOf(file), size: dup.size || 0, mtime: dup.mtime || 0 }, 409);
  }

  const body = await req.arrayBuffer();
  if (body.byteLength > max) return json({ error: `文件超过上限 ${(max / 1048576) | 0}MB` }, 413);
  if (!body.byteLength) return json({ error: '空文件' }, 400);

  await env.BUCKET.put(bookKey(slug, file), body, { httpMetadata: { contentType: contentType(file) } });

  const ok = await updateCat(env, slug, (cat) => {
    if (catName) cat.name = catName;
    if (!Array.isArray(cat.books)) cat.books = [];
    const rec = { file, title: titleOf(file), size: body.byteLength, mtime: Date.now() };
    const i = cat.books.findIndex((b) => b.file === file);
    if (i >= 0) cat.books[i] = rec;
    else cat.books.push(rec);
    return cat;
  });
  if (!ok) {
    // 索引写失败：新增场景回滚刚写的对象，不留幽灵文件占配额；
    // 覆盖场景保留对象（旧版已被覆盖无法找回），提示重建索引
    if (!dup) await env.BUCKET.delete(bookKey(slug, file));
    return json(
      { error: dup ? '索引写入冲突，请稍后重试；如文件已覆盖请重建索引' : '索引写入冲突，本次上传已回滚，请重试' },
      409
    );
  }

  await syncCatToRoot(env, slug, catName || undefined);
  return json({ ok: true, size: body.byteLength });
}

/** 软删除核心：单本与批量共用。每本约 8 次 subrequest */
async function trashBook(env, slug, file) {
  const key = bookKey(slug, file);
  const src = await env.BUCKET.get(key);
  if (!src) return { file, ok: false, error: '文件不存在' };

  const ts = Date.now();
  await env.BUCKET.put(trashKey(ts, slug, file), await src.arrayBuffer(), { httpMetadata: { contentType: contentType(file) } });
  await env.BUCKET.delete(key);

  const updated = await updateCat(env, slug, (cat) => {
    cat.books = (cat.books || []).filter((b) => b.file !== file);
    return cat;
  });
  // 文件已进回收站但索引没改成：不能报 ok，否则客户端看到的是「删好了」的幽灵索引
  if (!updated) return { file, ok: false, error: '索引写入冲突，文件已进回收站，请重建索引后恢复' };
  await syncCatToRoot(env, slug);
  return { file, ok: true, trash: trashKey(ts, slug, file) };
}

async function apiDelete(req, env) {
  const body = await req.json().catch(() => ({}));
  const slug = safeSeg(body.slug);
  const file = safeSeg(body.file);
  if (!slug || !file) return json({ error: '参数不合法' }, 400);
  const r = await trashBook(env, slug, file);
  if (!r.ok) return json({ error: r.error }, r.error === '文件不存在' ? 404 : 400);
  return json({ ok: true, trash: r.trash });
}

/**
 * 批量软删除。Workers Free 单次调用只有 50 次 subrequest，
 * 软删除每本约 8 次，所以单次上限 5 本，客户端分批。
 */
async function apiBatchDelete(req, env) {
  const body = await req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: '缺少 items' }, 400);
  if (items.length > 5) return json({ error: '单次最多 5 项，请分批调用' }, 413);

  const results = [];
  for (const it of items) {
    const slug = safeSeg(it && it.slug);
    const file = safeSeg(it && it.file);
    if (!slug || !file) {
      results.push({ file, ok: false, error: '参数不合法' });
      continue;
    }
    results.push(await trashBook(env, slug, file));
  }
  return json({ results });
}

/**
 * 移动分类 / 改名。底层同一条路：get → put 新 key → delete 旧 key → 双分片改索引。
 * 目标分类不存在时会自动创建（syncCatToRoot 会把它登记进 root.json）。
 */
async function moveBook(env, slug, file, toSlug, newName) {
  const dst = safeSeg(newName) || file;
  if (slug === toSlug && dst === file) return { file, ok: true, noop: true };

  const { data: dstCat } = await readMeta(env.BUCKET, metaCat(toSlug), { books: [] });
  if ((dstCat.books || []).some((b) => b.file === dst)) {
    return { file, ok: false, error: `目标分类已有《${dst}》` };
  }

  const src = await env.BUCKET.get(bookKey(slug, file));
  if (!src) return { file, ok: false, error: '文件不存在' };
  const buf = await src.arrayBuffer();
  await env.BUCKET.put(bookKey(toSlug, dst), buf, { httpMetadata: { contentType: contentType(dst) } });
  await env.BUCKET.delete(bookKey(slug, file));

  const srcOk = await updateCat(env, slug, (cat) => {
    cat.books = (cat.books || []).filter((b) => b.file !== file);
    return cat;
  });
  const dstOk = await updateCat(env, toSlug, (cat) => {
    if (!Array.isArray(cat.books)) cat.books = [];
    // 同分类改名时，这里既清旧名也去重新名，避免重复条目
    cat.books = cat.books.filter((b) => b.file !== dst);
    cat.books.push({ file: dst, title: titleOf(dst), size: buf.byteLength, mtime: Date.now() });
    return cat;
  });
  // 文件已搬但索引冲突：如实上报，让用户重建索引兜底，而不是假装成功
  if (!srcOk || !dstOk) return { file, ok: false, error: '索引写入冲突，文件已搬运，请重建索引' };
  await syncCatToRoot(env, slug);
  await syncCatToRoot(env, toSlug);
  return { file, ok: true };
}

/**
 * 单次最多 3 项。每项约 14 次 subrequest（get/put/delete + 两次乐观锁改索引
 * + 两次 syncCatToRoot），Workers Free 单次调用上限 50 次：5 项 × 14 = 70 必爆，
 * 3 项 × 14 = 42 留 8 次余量。客户端按 3 项分批。
 */
async function apiMove(req, env) {
  const body = await req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: '缺少 items' }, 400);
  if (items.length > 3) return json({ error: '单次最多 3 项，请分批调用' }, 413);

  const results = [];
  for (const it of items) {
    const slug = safeSeg(it && it.slug);
    const file = safeSeg(it && it.file);
    const toSlug = safeSeg(it && it.toSlug);
    if (!slug || !file || !toSlug) {
      results.push({ file, ok: false, error: '参数不合法' });
      continue;
    }
    results.push(await moveBook(env, slug, file, toSlug, it.newName));
  }
  return json({ results });
}

/** 回收站列表 + 惰性过期清理。
 * key 自带软删时间戳（_trash/<ts>/<file>），所以打开回收站时顺手删掉超期对象即可——
 * 不加任何定时任务、不产生额外请求。单次最多清 45 个（list 1 次 + delete 45 次 < 50-subrequest
 * 上限），没删完的留到下一次打开时再清。过期时长用 TRASH_TTL_MS 调（默认 30 天）。 */
async function apiTrash(env) {
  const list = await env.BUCKET.list({ prefix: '_trash/' });
  const objects = list.objects;
  const ttl = Number(env.TRASH_TTL_MS) || 30 * 86400000;
  const now = Date.now();
  const expired = objects.filter((o) => {
    const ts = Number(o.key.slice('_trash/'.length).split('/')[0]);
    return Number.isFinite(ts) && now - ts > ttl;
  });
  const doomed = expired.slice(0, 45);
  for (const o of doomed) await env.BUCKET.delete(o.key);
  const doomedKeys = new Set(doomed.map((o) => o.key));
  const items = objects
    .filter((o) => !doomedKeys.has(o.key))
    .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded ? o.uploaded.getTime() : 0 }));
  return json({ items, purged: doomed.length });
}

async function apiRestore(req, env) {
  const body = await req.json().catch(() => ({}));
  const key = String(body.key || '');
  const slug = safeSeg(body.slug);
  if (!key.startsWith('_trash/') || !slug) return json({ error: '参数不合法' }, 400);
  // key = _trash/<时间戳>/<分类>/<文件名>，取最后一段为真实文件名（兼容旧格式 _trash/<ts>/<file>）
  const file = safeSeg(key.slice(key.lastIndexOf('/') + 1));
  if (!file) return json({ error: '参数不合法' }, 400);

  const src = await env.BUCKET.get(key);
  if (!src) return json({ error: '回收站里没有这个文件' }, 404);

  // 目标分类已有同名书时拒绝恢复：直接覆盖会让索引里的 size/mtime 与实际文件错位
  const { data: cat0 } = await readMeta(env.BUCKET, metaCat(slug), { books: [] });
  if ((cat0.books || []).some((b) => b.file === file)) {
    return json({ error: `目标分类已有《${file}》，先改名/换分类，或先删除现有同名书`, exists: true }, 409);
  }

  const buf = await src.arrayBuffer();
  await env.BUCKET.put(bookKey(slug, file), buf, { httpMetadata: { contentType: contentType(file) } });
  await env.BUCKET.delete(key);

  const ok = await updateCat(env, slug, (cat) => {
    if (!Array.isArray(cat.books)) cat.books = [];
    if (!cat.books.some((b) => b.file === file)) {
      cat.books.push({ file, title: titleOf(file), size: buf.byteLength, mtime: Date.now() });
    }
    return cat;
  });
  if (!ok) return json({ error: '索引写入冲突，文件已恢复但书目未登记，请重建索引', recovered: true }, 409);
  await syncCatToRoot(env, slug);
  return json({ ok: true });
}

async function apiPurge(req, env) {
  const body = await req.json().catch(() => ({}));
  const keys = (Array.isArray(body.keys) ? body.keys : [body.key]).filter(
    (k) => typeof k === 'string' && k.startsWith('_trash/')
  );
  if (!keys.length) return json({ error: '缺少 keys' }, 400);
  // 每次 delete 1 次 subrequest，Workers Free 上限 50，留余量
  if (keys.length > 40) return json({ error: '单次最多 40 项，请分批' }, 413);
  for (const k of keys) await env.BUCKET.delete(k);
  return json({ ok: true, purged: keys.length });
}

/**
 * 从 R2 实际对象重建索引，按分类分批，每次调用只处理一个分类，
 * 避免 1000+ 本时单次请求顶到 Workers 的 CPU 上限。
 */
async function apiRebuild(req, env) {
  const body = await req.json().catch(() => ({}));
  let slugs = Array.isArray(body.slugs) ? body.slugs : null;

  if (!slugs) {
    const listed = await env.BUCKET.list({ prefix: 'books/', delimiter: '/' });
    slugs = (listed.delimitedPrefixes || []).map((p) => p.slice('books/'.length).replace(/\/$/, '')).filter(Boolean);
  }

  const idx = body.cursor ? slugs.indexOf(body.cursor) : -1;
  const next = slugs[idx + 1];

  if (!next) {
    // 收尾：剔掉 root.json 里已不存在的分类
    const seen = new Set(slugs);
    await updateRoot(env, (root) => {
      root.cats = (root.cats || []).filter((c) => seen.has(c.slug));
      root.updatedAt = Date.now();
      return root;
    });
    return json({ done: true, slugs });
  }

  const prefix = `books/${next}/`;
  const books = [];
  let cursor;
  let rounds = 0;
  // 每页 1000 本，最多读 45 页（45000 本）——比原来 5 页（5000 本）不再截断小库；
  // 真超 45000 本则明确报错而不是写截断索引（对象仍在 R2，避免索引与实物脱节）
  do {
    const r = await env.BUCKET.list({ prefix, cursor });
    for (const o of r.objects) {
      const f = o.key.slice(prefix.length);
      if (!f) continue;
      books.push({ file: f, title: titleOf(f), size: o.size, mtime: o.uploaded ? o.uploaded.getTime() : Date.now() });
    }
    cursor = r.truncated ? r.cursor : undefined;
    rounds++;
  } while (cursor && rounds < 45);
  if (cursor) return json({ error: `分类「${next}」超过 45000 本，无法一次重建，请拆分后再试` }, 409);

  const { data: cat } = await readMeta(env.BUCKET, metaCat(next), { books: [] });
  await putMeta(env.BUCKET, metaCat(next), { name: (cat && cat.name) || next, books }, null);
  await syncCatToRoot(env, next);

  return json({ done: false, cursor: next, slugs, count: books.length });
}

async function handleApi(req, env, url, p) {
  if (p === '/api/login') return req.method === 'POST' ? apiLogin(req, env) : json({ error: 'method' }, 405);
  if (!(await verifyCookie(req, env))) return json({ error: 'unauthorized' }, 401);

  // 全部限方法：改数据接口只认 POST/DELETE，GET 一律 405。
  // SameSite=Lax 下跨站顶级 GET 导航也会带 cookie，方法限制堵住「点链接即改库」的 CSRF 链
  if (p === '/api/logout' && req.method === 'POST') return apiLogout(req);
  if (p === '/api/state' && req.method === 'GET') return apiState(env);
  if (p === '/api/trash' && req.method === 'GET') return apiTrash(env);
  if (p === '/api/upload' && req.method === 'POST') return apiUpload(req, env, url);
  if (p === '/api/delete' && req.method === 'POST') return apiDelete(req, env);
  if (p === '/api/batch-delete' && req.method === 'POST') return apiBatchDelete(req, env);
  if (p === '/api/move' && req.method === 'POST') return apiMove(req, env);
  if (p === '/api/restore' && req.method === 'POST') return apiRestore(req, env);
  if (p === '/api/purge' && req.method === 'POST') return apiPurge(req, env);
  if (p === '/api/cat' && req.method === 'POST') return apiCatUpsert(req, env);
  if (p === '/api/cat' && req.method === 'DELETE') return apiCatDelete(req, env);
  if (p === '/api/rebuild' && req.method === 'POST') return apiRebuild(req, env);

  const m = /^\/api\/cat\/(.+)$/.exec(p);
  // pathname 保留百分号编码，前端 encodeURIComponent 过的中文 slug 必须先解码，
  // 否则 metaCat 拿编码串查 key 永远 404（「全部书目」视图因此恒为空）
  if (m && req.method === 'GET') return apiCatGet(env, safeSeg(decSeg(m[1])));

  return json({ error: 'not found' }, 404);
}

/* ---------------- 入口 ---------------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p.startsWith('/api/')) return handleApi(req, env, url, p);

    // 浏览器访问根路径 → 上传端页面（公开，登录在页内完成）
    if ((p === '/' || p === '/index.html') && req.method === 'GET' && (req.headers.get('accept') || '').includes('text/html')) {
      return env.ASSETS.fetch(req);
    }

    // 鉴权门：cookie（管理端）优先；无 cookie 才走 Basic Auth（手机），并对连续失败计数锁定
    let authed = await verifyCookie(req, env);
    if (!authed) {
      if (bruteLocked(req, env, 'dav')) return new Response('Too Many Requests', { status: 429 });
      authed = verifyBasic(req, env);
      if (authed) {
        bruteClear(req, env, 'dav'); // 一次成功即清空失败记录，正常用户偶发手误不记账
      } else if (req.headers.get('Authorization')) {
        // 只统计「确实带着凭据但密码错误」的请求；无凭据探测不计入失败
        bruteFail(req, env, 'dav');
      }
    }

    if (p.startsWith('/opds')) {
      if (!authed) return unauthorized(true);
      return handleOpds(req, env, p);
    }

    if (p === '/' || p.startsWith('/books')) {
      if (!authed) return unauthorized(true);
      return handleDav(req, env, p, 'books');
    }

    // Readingo 进度备份区：唯一可写通道，防护见 BACKUP_MAX*
    if (p === '/backup' || p.startsWith('/backup/')) {
      if (!authed) return unauthorized(true);
      return handleDav(req, env, p, 'backup');
    }

    if (!authed) return unauthorized(true);
    return env.ASSETS.fetch(req);
  },
};
