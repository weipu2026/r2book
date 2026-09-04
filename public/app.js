/* r2book 上传端 — 零依赖、零构建 */

const $ = (sel) => document.querySelector(sel);
const S = { cats: [], cur: 'all', books: [], totalBytes: 0, q: '', page: 1, pageSize: 50, maxUpload: 0, sel: new Set() };

const QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

/* ---------------- 工具 ---------------- */

function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtDate(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 220);
  }, 2400);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 中文小说 txt 大量是 GBK，用 fatal 模式探测后再决定解码器 */
function decodeNovel(buf) {
  const head = buf.slice(0, 65536);
  let enc = 'utf-8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head);
  } catch {
    try {
      new TextDecoder('gbk').decode(head);
      enc = 'gbk';
    } catch { /* 环境不支持 gbk，退回 utf-8 */ }
  }
  return { text: new TextDecoder(enc).decode(buf), enc };
}

function post(url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* 忽略 */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        const err = new Error(data.error || `HTTP ${xhr.status}`);
        err.status = xhr.status;
        err.data = data;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(body);
  });
}

async function runPool(items, worker, limit = 3) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  });
  await Promise.all(runners);
}

const catNameOf = (slug) => {
  const c = S.cats.find((x) => x.slug === slug);
  return c ? (c.name || c.slug) : slug;
};

/* ---------------- 渲染 ---------------- */

function renderQuota() {
  const pct = Math.min(100, (S.totalBytes / QUOTA_BYTES) * 100);
  $('#quota-fill').style.width = pct.toFixed(2) + '%';
  $('#quota-text').textContent = `${fmtSize(S.totalBytes)} / 10 GB`;
}

function renderCats() {
  const ul = $('#cat-list');
  ul.innerHTML = '';
  const mk = (slug, name, count) => {
    const li = document.createElement('li');
    li.className = S.cur === slug ? 'active' : '';
    li.innerHTML = `<span class="name"></span><span class="num"></span><span class="cat-op" title="重命名">改名</span>`;
    li.querySelector('.name').textContent = name;
    li.querySelector('.num').textContent = count;
    li.onclick = () => selectCat(slug);
    const op = li.querySelector('.cat-op');
    op.onclick = (e) => { e.stopPropagation(); renameCat(slug, name); };
    ul.appendChild(li);
  };
  const total = S.cats.reduce((s, c) => s + (Number(c.count) || 0), 0);
  mk('all', '全部', total);
  for (const c of S.cats) mk(c.slug, c.name || c.slug, Number(c.count) || 0);
  $('#dz-target').textContent = S.cur === 'all' ? '上传目标：请先在左侧选一个分类' : `上传目标：${catNameOf(S.cur)}`;
}

function filtered() {
  const q = S.q.trim().toLowerCase();
  if (!q) return S.books;
  return S.books.filter((b) => String(b.title || b.file).toLowerCase().includes(q));
}

const bkKey = (b) => `${b.slug}/${b.file}`;

function renderBooks() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / S.pageSize));
  if (S.page > pages) S.page = pages;
  const start = (S.page - 1) * S.pageSize;
  const slice = list.slice(start, start + S.pageSize);

  const body = $('#book-body');
  body.innerHTML = '';
  for (const b of slice) {
    const tr = document.createElement('tr');
    const sizeCell = `<td class="col-size cell-dim">${fmtSize(b.size)}</td>`;
    const timeCell = `<td class="col-time cell-dim">${fmtDate(b.mtime)}</td>`;
    const catCell = `<td class="col-cat cell-dim"></td>`;
    tr.innerHTML =
      `<td class="col-ck"><input type="checkbox" class="ck"></td>` +
      `<td><div class="book-title"></div></td>${catCell}${sizeCell}${timeCell}` +
      `<td class="col-op"><button class="btn tiny op-move">移动</button><button class="btn tiny danger">删除</button></td>`;
    tr.querySelector('.ck').checked = S.sel.has(bkKey(b));
    tr.querySelector('.ck').onchange = (e) => {
      if (e.target.checked) S.sel.add(bkKey(b));
      else S.sel.delete(bkKey(b));
      renderBatchBar();
    };
    tr.children[1].firstChild.textContent = b.title || b.file;
    tr.querySelector('.col-cat').textContent = b.catName || '';
    tr.querySelector('.op-move').onclick = () => openMoveModal([b], true);
    tr.querySelector('.btn.danger').onclick = () => deleteBook(b);
    body.appendChild(tr);
  }
  $('#ck-all').checked = slice.length > 0 && slice.every((b) => S.sel.has(bkKey(b)));
  $('#ck-all').indeterminate = !$('#ck-all').checked && slice.some((b) => S.sel.has(bkKey(b)));

  $('#empty-tip').hidden = list.length !== 0;
  $('#list-count').textContent = list.length ? `${list.length} 本` : '';
  $('#list-title').textContent = S.cur === 'all' ? '全部书目' : catNameOf(S.cur);
  renderBatchBar();

  const pager = $('#pager');
  pager.hidden = pages <= 1;
  $('#page-info').textContent = `${S.page} / ${pages}`;
  $('#page-prev').disabled = S.page <= 1;
  $('#page-next').disabled = S.page >= pages;
}

/* ---------------- 批量操作 ---------------- */

/* 批次大小：删除每本约 8 次 subrequest（5×8=40 < 50）；
 * 移动每本约 14 次（5×14=70 必爆），服务端上限 3，前端按 3 分批 */
const BATCH_CHUNK_DEL = 5;
const BATCH_CHUNK_MOVE = 3;

async function chunked(items, fn, size) {
  const n = size || BATCH_CHUNK_DEL;
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    const r = await fn(items.slice(i, i + n));
    if (Array.isArray(r)) out.push(...r);
  }
  return out;
}

function selBooks() {
  const byKey = new Map(S.books.map((b) => [bkKey(b), b]));
  return Array.from(S.sel).map((k) => byKey.get(k)).filter(Boolean);
}

function renderBatchBar() {
  const bar = $('#batch-bar');
  const n = S.sel.size;
  bar.hidden = n === 0;
  $('#batch-count').textContent = `已选 ${n} 本`;
}

async function batchDelete() {
  const items = selBooks();
  if (!items.length) return;
  if (!confirm(`把选中的 ${items.length} 本移进回收站？`)) return;
  const results = await chunked(items, (part) =>
    api('/api/batch-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: part.map((b) => ({ slug: b.slug, file: b.file })) }),
    }).then((r) => r.results || []).catch((e) => { toast(e.message); return []; })
  );
  S.sel.clear();
  await loadState();
  toast(results.length ? `已移入回收站 ${results.filter((r) => r.ok).length} 本` : '没有完成任何删除');
}

/* ---------------- 移动 / 改名弹窗 ---------------- */

let modalItems = [];
let modalAllowRename = false;

function openMoveModal(items, allowRename) {
  if (!S.cats.length) { toast('还没有分类，先新建一个'); return; }
  modalItems = items;
  modalAllowRename = allowRename;
  $('#modal-title').textContent = items.length > 1 ? `移动 ${items.length} 本到…` : `移动《${items[0].title || items[0].file}》`;
  const box = $('#modal-cats');
  box.innerHTML = '';
  const sameCat = items.length === 1 ? items[0].slug : null;
  for (const c of S.cats) {
    const label = document.createElement('label');
    label.className = 'modal-cat';
    label.innerHTML = `<input type="radio" name="modal-cat"><span></span><em></em>`;
    const radio = label.querySelector('input');
    radio.value = c.slug; // slug 不经 HTML 内插，杜绝属性注入
    radio.checked = sameCat ? c.slug === sameCat : false;
    label.querySelector('span').textContent = c.name || c.slug;
    label.querySelector('em').textContent = `${Number(c.count) || 0} 本`;
    box.appendChild(label);
  }
  const renameRow = $('#modal-rename-row');
  renameRow.hidden = !(allowRename && items.length === 1);
  if (!renameRow.hidden) $('#modal-name').value = items[0].file;
  $('#modal-err').textContent = '';
  $('#modal').hidden = false;
  if (!renameRow.hidden) { $('#modal-name').focus(); $('#modal-name').select(); }
}

function closeMoveModal() {
  $('#modal').hidden = true;
  modalItems = [];
}

async function confirmMoveModal() {
  const picked = document.querySelector('input[name="modal-cat"]:checked');
  if (!picked) { $('#modal-err').textContent = '选一个目标分类'; return; }
  const toSlug = picked.value;
  const newName = modalAllowRename && modalItems.length === 1 ? $('#modal-name').value.trim() : '';
  if (newName === '' && modalAllowRename && modalItems.length === 1) { $('#modal-err').textContent = '文件名不能为空'; return; }

  const items = modalItems.map((b) => ({
    slug: b.slug,
    file: b.file,
    toSlug,
    ...(newName && newName !== b.file ? { newName } : {}),
  }));
  const results = await chunked(items, (part) =>
    api('/api/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: part }),
    }).then((r) => r.results || []).catch((e) => { $('#modal-err').textContent = e.message; return null; })
  , BATCH_CHUNK_MOVE);
  if (results === null) return; // 出错，弹窗留着让用户改
  const okCount = results.filter((r) => r.ok).length;
  closeMoveModal();
  S.sel.clear();
  await loadState();
  const errs = results.filter((r) => !r.ok);
  toast(errs.length ? `成功 ${okCount} 本，失败 ${errs.length} 本：${errs[0].error}` : okCount ? `已移动 ${okCount} 本` : '没有变化');
}

/* ---------------- 数据加载 ---------------- */

async function loadState() {
  try {
    const st = await api('/api/state');
    S.cats = st.cats || [];
    S.totalBytes = Number(st.totalBytes) || 0;
    S.maxUpload = Number(st.maxUpload) || 0;
    $('#site-name').textContent = st.site || '私人书库';
    if (S.cur !== 'all' && !S.cats.some((c) => c.slug === S.cur)) S.cur = 'all';
    renderQuota();
    renderCats();
    await loadBooks();
    return true;
  } catch (e) {
    if (e.status === 401) return false;
    toast(e.message);
    return true;
  }
}

async function loadBooks() {
  if (S.cur === 'all') {
    const groups = await Promise.all(
      S.cats.map((c) =>
        api('/api/cat/' + encodeURIComponent(c.slug))
          .then((r) => (r.books || []).map((b) => ({ ...b, slug: c.slug, catName: c.name || c.slug })))
          .catch(() => [])
      )
    );
    S.books = groups.flat().sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  } else {
    const r = await api('/api/cat/' + encodeURIComponent(S.cur));
    S.books = (r.books || []).map((b) => ({ ...b, slug: S.cur, catName: r.name || S.cur }));
  }
  S.page = 1;
  renderBooks();
}

function selectCat(slug) {
  S.cur = slug;
  S.page = 1;
  S.sel.clear(); // 换分类就清空选择，避免跨分类批量误伤
  renderCats();
  loadBooks();
}

/* ---------------- 分类操作 ---------------- */

async function newCat() {
  const name = (prompt('新建分类，输入名称（如：玄幻、都市、历史）') || '').trim();
  if (!name) return;
  try {
    const r = await api('/api/cat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: name, name }),
    });
    await loadState();
    S.cur = r.slug; // 用服务端规范化后的 slug，可能与输入的 name 不同
    renderCats();
    await loadBooks();
    toast(`已创建分类「${name}」`);
  } catch (e) {
    toast(e.message);
  }
}

async function renameCat(slug, oldName) {
  const name = (prompt('重命名分类', oldName) || '').trim();
  if (!name || name === oldName) return;
  try {
    await api('/api/cat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, name }),
    });
    await loadState();
    toast('已重命名');
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------- 上传 ---------------- */

function queueRow(name) {
  const wrap = $('#queue');
  wrap.hidden = false;
  const el = document.createElement('div');
  el.className = 'queue-item';
  el.innerHTML = `<span class="qn"></span><span class="qbar"><span class="qfill"></span></span><span class="qs"></span>`;
  el.querySelector('.qn').textContent = name;
  wrap.appendChild(el);
  const fill = el.querySelector('.qfill');
  const note = el.querySelector('.qs');
  return {
    progress(r) { fill.style.width = (r * 100).toFixed(1) + '%'; note.textContent = (r * 100).toFixed(0) + '%'; },
    note(t) { note.textContent = t; },
    done(extra) { fill.style.width = '100%'; note.textContent = '完成 ' + extra; },
    fail(msg) { el.classList.add('err'); note.textContent = msg; },
  };
}

const WORD_EXT = /\.(docx?|wps|rtf|odt)$/i;

/* 只有纯文本才需要 GBK→UTF-8 转码；epub/pdf/mobi 等是二进制，
 * 转码会把它当成乱码文本重编码导致文件损坏，必须原样上传 */
const TEXT_EXT = /\.(txt|text)$/i;

/* 书名清洗：剥掉中英文括号里带广告特征词的片段，保留《》书名号与正常括号 */
const AD_BRACKET =
  /[【\[(（][^【】\[\]（）()]*?(?:www\s?\.|https?:\/\/|\.(?:com|net|cc|org|info|top|xyz)\b|小说|文学|首发|手打|笔趣|书城|阅读网|更新最快|无弹窗|全文阅读|免费阅|书友|交流群)[^【】\[\]（）()]*?[】\])）]/gi;
const AD_EDGE = /^[\s\-_—·~.。]+|[\s\-_—·~.。]+$/g;

function cleanBookName(name) {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/.exec(String(name));
  const raw = (m && m[1]) || String(name);
  const ext = (m && m[2]) || '';
  let base = raw.replace(AD_BRACKET, '').replace(AD_EDGE, '').replace(/\s{2,}/g, ' ').trim();
  if (!base) base = raw.trim() || '未命名';
  return base + ext;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (S.cur === 'all') {
    toast('请先在左侧选一个分类，再上传');
    return;
  }
  const slug = S.cur;
  const catName = catNameOf(slug);

  const bad = files.filter((f) => WORD_EXT.test(f.name));
  if (bad.length && !confirm(`有 ${bad.length} 个 Word 文档，Readingo 打不开，需要先在电脑上用 Calibre 转成 txt 或 epub。\n仍要上传吗？`)) return;

  const oversize = files.filter((f) => S.maxUpload && f.size > S.maxUpload);
  if (oversize.length) {
    toast(`${oversize.length} 个文件超过上限 ${fmtSize(S.maxUpload)}，已跳过`);
  }
  const todo = files.filter((f) => !oversize.includes(f));
  if (!todo.length) return;

  await runPool(todo, async (f) => {
    const fname = $('#opt-clean').checked ? cleanBookName(f.name) : f.name;
    const row = queueRow(fname !== f.name ? `${f.name} → ${fname}` : f.name);
    try {
      const buf = await f.arrayBuffer();
      let out = buf;
      if (TEXT_EXT.test(fname)) {
        row.note('转码中');
        const { text, enc } = decodeNovel(buf);
        out = new TextEncoder().encode(text);
        row.note(enc === 'gbk' ? 'GBK → UTF-8' : enc);
      } else {
        row.note('原样上传');
      }
      const url = `/api/upload?cat=${encodeURIComponent(slug)}&catName=${encodeURIComponent(catName)}&file=${encodeURIComponent(fname)}`;
      let res;
      try {
        res = await post(url, out, (r) => row.progress(r));
      } catch (e) {
        if (e.status === 409 && e.data && e.data.exists) {
          const old = fmtSize(Number(e.data.size) || 0);
          const when = e.data.mtime ? fmtDate(e.data.mtime) : '';
          const msg =
            `书库里已有《${e.data.title || fname}》（${old}${when ? '，' + when + ' 传的' : ''}）。\n\n` +
            '覆盖重传吗？\n注意：手机 Readingo 里已下载的旧版不会自动更新，需删除后重新下载才能看到新版。';
          if (!confirm(msg)) {
            row.fail('已跳过（保留原书）');
            return;
          }
          res = await post(url + '&ow=1', out, (r) => row.progress(r));
        } else {
          throw e;
        }
      }
      row.done(fmtSize((res && res.size) || out.byteLength));
    } catch (e) {
      row.fail(e.message);
    }
  });

  await loadState();
  setTimeout(() => { $('#queue').hidden = true; $('#queue').innerHTML = ''; }, 4000);
}

/* ---------------- 删除与回收站 ---------------- */

async function deleteBook(b) {
  if (!confirm(`把《${b.title || b.file}》移进回收站？`)) return;
  try {
    await api('/api/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: b.slug, file: b.file }),
    });
    await loadState();
    toast('已移入回收站');
  } catch (e) {
    toast(e.message);
  }
}

let trashItems = [];

async function loadTrash() {
  const box = $('#trash-body');
  box.innerHTML = '加载中…';
  try {
    const r = await api('/api/trash');
    const items = trashItems = r.items || [];
    $('#trash-count').textContent = items.length ? `(${items.length})` : '';
    box.innerHTML = '';
    if (!items.length) {
      box.innerHTML = '<span class="trash-empty">回收站是空的</span>';
      return;
    }
    for (const it of items) {
      const name = it.key.split('/').pop();
      const row = document.createElement('div');
      row.className = 'trash-item';
      row.innerHTML = `<span class="tn"></span><span class="cell-dim"></span><button class="btn tiny">恢复</button><button class="btn tiny danger">彻底删除</button>`;
      row.querySelector('.tn').textContent = name;
      row.querySelector('.cell-dim').textContent = fmtSize(it.size);
      row.querySelector('.btn:not(.danger)').onclick = async () => {
        if (S.cur === 'all') { toast('请先选一个分类作为恢复目标'); return; }
        try {
          await api('/api/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: it.key, slug: S.cur }),
          });
          await loadState();
          await loadTrash();
          toast('已恢复');
        } catch (e) {
          toast(e.message);
        }
      };
      row.querySelector('.btn.danger').onclick = async () => {
        if (!confirm(`彻底删除《${name}》？此操作不可撤销。`)) return;
        try {
          await api('/api/purge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ keys: [it.key] }),
          });
          await loadTrash();
          toast('已彻底删除');
        } catch (e) {
          toast(e.message);
        }
      };
      box.appendChild(row);
    }
  } catch (e) {
    box.textContent = '加载失败：' + e.message; // 不走 innerHTML，防错误消息带 HTML
  }
}

/* 清空回收站：复用 /api/purge，按 40 个 key 一批循环，不占新接口 */
async function clearTrash() {
  if (!trashItems.length) { toast('回收站是空的'); return; }
  if (!confirm(`彻底删除回收站里全部 ${trashItems.length} 个文件？此操作不可撤销。`)) return;
  let done = 0;
  try {
    const keys = trashItems.map((it) => it.key);
    for (let i = 0; i < keys.length; i += 40) {
      const r = await api('/api/purge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: keys.slice(i, i + 40) }),
      });
      done += Number(r && r.purged) || 0;
    }
    await loadState();
    await loadTrash();
    toast(`已彻底删除 ${done} 个文件`);
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------- 重建索引 ---------------- */

async function rebuild() {
  if (!confirm('从 R2 里的实际文件重建索引？\n用于上传中断、索引错乱，或用 rclone 直接灌过文件之后。')) return;
  try {
    let cursor = null;
    let slugs = null;
    let count = 0;
    for (;;) {
      const r = await api('/api/rebuild', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cursor, slugs }),
      });
      slugs = r.slugs;
      count += Number(r.count) || 0;
      if (r.done) break;
      cursor = r.cursor;
    }
    await loadState();
    toast(`重建完成，共 ${count} 本`);
  } catch (e) {
    toast('重建失败：' + e.message);
  }
}

/* ---------------- 启动 ---------------- */

function bind() {
  const dz = $('#dropzone');
  const input = $('#file-input');
  $('#btn-pick').onclick = () => input.click();
  input.onchange = () => { handleFiles(input.files); input.value = ''; };

  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    handleFiles(e.dataTransfer.files);
  };

  $('#btn-new-cat').onclick = newCat;
  $('#btn-rebuild').onclick = rebuild;
  $('#btn-logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  };

  $('#search').oninput = (e) => { S.q = e.target.value; S.page = 1; renderBooks(); };
  $('#page-prev').onclick = () => { if (S.page > 1) { S.page--; renderBooks(); } };
  $('#page-next').onclick = () => { S.page++; renderBooks(); };

  // 批量选择与操作
  $('#ck-all').onchange = (e) => {
    const list = filtered().slice((S.page - 1) * S.pageSize, S.page * S.pageSize);
    for (const b of list) {
      if (e.target.checked) S.sel.add(bkKey(b));
      else S.sel.delete(bkKey(b));
    }
    renderBooks();
  };
  $('#btn-batch-del').onclick = batchDelete;
  $('#btn-batch-move').onclick = () => {
    const items = selBooks();
    if (items.length) openMoveModal(items, false);
  };
  $('#btn-batch-cancel').onclick = () => { S.sel.clear(); renderBooks(); };

  // 移动/改名弹窗
  $('#modal-cancel').onclick = closeMoveModal;
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeMoveModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeMoveModal(); });
  $('#modal-ok').onclick = confirmMoveModal;
  $('#modal-name').onkeydown = (e) => { if (e.key === 'Enter') confirmMoveModal(); };

  document.querySelector('.trash-box').addEventListener('toggle', (e) => {
    if (e.target.open) loadTrash();
  });

  // summary 里的「清空」按钮：先阻止折叠展开，再执行清理
  const clearBtn = $('#btn-trash-clear');
  if (clearBtn) {
    clearBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearTrash();
    };
  }

  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const pwd = $('#login-pwd').value;
    const err = $('#login-err');
    err.textContent = '';
    try {
      await api('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      $('#login').hidden = true;
      $('#app').hidden = false;
      await loadState();
    } catch (err2) {
      err.textContent = err2.message;
    }
  };
}

(async function start() {
  bind();
  const ok = await loadState();
  if (ok) {
    $('#login').hidden = true;
    $('#app').hidden = false;
  } else {
    $('#app').hidden = true;
  }
})();
