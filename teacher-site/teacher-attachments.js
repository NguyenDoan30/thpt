/* Private cloud files for authenticated teachers; demo blobs use IndexedDB. */
'use strict';
window.createTeacherAttachments = function ({ esc, getContext, onError }) {
  const bucket = 'teacher-homework-files', maxFiles = 5, maxSize = 5 * 1024 * 1024;
  const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain' };
  const memory = new Map(), known = new Map(), urls = new Map();
  let database, lifecycle = 0;
  function openDatabase() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('thpt-teacher-homework-files-v1', 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('files')) request.result.createObjectStore('files'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { database = null; reject(request.error || new Error('demo_storage')); };
    });
    return database;
  }
  async function store(action, key, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('files', action === 'get' ? 'readonly' : 'readwrite');
      const objectStore = transaction.objectStore('files');
      const request = action === 'put' ? objectStore.put(value, key) : action === 'delete' ? objectStore.delete(key) : objectStore.get(key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('demo_storage'));
    });
  }
  function normalize(value) {
    return (Array.isArray(value) ? value : []).filter(item => item && typeof item.id === 'string' && typeof item.path === 'string' && typeof item.name === 'string' && Object.values(types).includes(item.type) && Number.isInteger(item.size) && item.size > 0 && item.size <= maxSize).slice(0, maxFiles).map(item => ({ id: item.id, name: item.name, type: item.type, size: item.size, path: item.path }));
  }
  function select(files, existing, homeworkId, imagesOnly) {
    const selected = Array.from(files || []), c = getContext();
    if (existing.length + selected.length > maxFiles) throw new Error('Mỗi bài tập được đính kèm tối đa 5 tệp.');
    const prepared = selected.map(file => {
      const extension = file.name.split('.').pop().toLowerCase(), type = types[extension];
      if (!type || (imagesOnly && !type.startsWith('image/')) || (file.type && file.type !== 'application/octet-stream' && file.type !== type)) throw new Error('Chỉ hỗ trợ ảnh PNG, JPG, WebP, GIF, PDF, Word, Excel, PowerPoint và TXT.');
      if (!file.size || file.size > maxSize) throw new Error('Mỗi tệp phải có dung lượng lớn hơn 0 và không quá 5 MB.');
      if (file.name.length > 255 || /[/\\\u0000-\u001f\u007f]/.test(file.name)) throw new Error('Tên tệp không hợp lệ hoặc quá dài.');
      const id = crypto.randomUUID();
      return { meta: { id, name: file.name, type, size: file.size, path: [c.user.id, c.selectedSchool, homeworkId, id + '.' + extension].join('/') }, blob: new Blob([file], { type }) };
    });
    for (const item of prepared) memory.set(item.meta.path, { blob: item.blob, uploaded: false });
    return [...existing, ...prepared.map(item => item.meta)];
  }
  function sizeLabel(size) { return size < 1024 * 1024 ? Math.max(1, Math.ceil(size / 1024)) + ' KB' : (size / (1024 * 1024)).toFixed(1) + ' MB'; }
  function render(files, draft = false) {
    return '<ul class="homework-attachments-list">' + normalize(files).map(file => {
      known.set(file.id, file);
      return '<li class="homework-attachment">' + (file.type.startsWith('image/') ? '<img class="homework-attachment-preview" data-homework-preview="' + esc(file.id) + '" alt="Ảnh đính kèm: ' + esc(file.name) + '" loading="lazy">' : '<span class="homework-file-icon" aria-hidden="true">TỆP</span>') + '<div class="homework-file-info"><span class="homework-file-name">' + esc(file.name) + '</span><small>' + sizeLabel(file.size) + '</small></div><button class="btn btn-secondary" type="button" ' + (draft ? 'data-homework-remove-file' : 'data-homework-download') + '="' + esc(file.id) + '" aria-label="' + (draft ? 'Gỡ tệp ' : 'Tải tệp ') + esc(file.name) + '">' + (draft ? 'Gỡ' : 'Tải xuống') + '</button></li>';
    }).join('') + '</ul>';
  }
  function scopeKey(c) { return [c.user?.id, c.selectedSchool, c.portal?.current, c.demoMode].join('|'); }
  async function getUrl(file) {
    const c = getContext(), key = scopeKey(c), epoch = lifecycle, cached = urls.get(file.path);
    if (cached && cached.expires > Date.now()) return cached.url;
    const local = memory.get(file.path);
    let url;
    if (local?.blob || c.demoMode) {
      const blob = local?.blob || await store('get', file.path);
      if (!(blob instanceof Blob)) throw new Error('Không tìm thấy tệp trên thiết bị này.');
      if (key !== scopeKey(getContext()) || epoch !== lifecycle) throw new Error('Phiên làm việc đã thay đổi.');
      url = URL.createObjectURL(blob); urls.set(file.path, { url, expires: Infinity, local: true });
    } else {
      const result = await c.client.storage.from(bucket).createSignedUrl(file.path, 120);
      if (result.error) throw new Error('Chưa tải được tệp. Kiểm tra kết nối hoặc quyền truy cập.');
      if (key !== scopeKey(getContext()) || epoch !== lifecycle) throw new Error('Phiên làm việc đã thay đổi.');
      url = result.data?.signedUrl;
      if (!url || !/^https?:\/\//.test(url)) throw new Error('Chưa tải được tệp.');
      urls.set(file.path, { url, expires: Date.now() + 100000, local: false });
    }
    return url;
  }
  function hydrate(root) {
    root?.querySelectorAll('img[data-homework-preview]').forEach(async image => {
      const file = known.get(image.dataset.homeworkPreview); if (!file || image.hasAttribute('src')) return;
      try { const url = await getUrl(file); if (image.isConnected) image.src = url; }
      catch { if (image.isConnected) { image.hidden = true; image.parentElement.classList.add('homework-preview-unavailable'); } }
    });
  }
  async function prepare(files) {
    const c = getContext(), key = scopeKey(c), epoch = lifecycle;
    for (const file of files) {
      const local = memory.get(file.path); if (!local || local.uploaded) continue;
      if (c.demoMode) await store('put', file.path, local.blob);
      else {
        if (!c.client?.storage) throw new Error('Nhà trường chưa bật chức năng đính kèm tệp.');
        let result;
        try { result = await c.client.storage.from(bucket).upload(file.path, local.blob, { contentType: file.type, upsert: false }); }
        catch (problem) { result = { error: problem }; }
        if (result.error) {
          // A response may be lost after Storage accepted the upload. Verify the
          // private object before retrying its immutable path, never overwrite it.
          const existing = await c.client.storage.from(bucket).download(file.path);
          if (existing.error || !(existing.data instanceof Blob) || existing.data.size !== file.size || existing.data.type !== file.type) throw new Error('Chưa tải tệp lên được. Kiểm tra kết nối hoặc nhờ quản trị viên bật lưu tệp.');
          const hashes = await Promise.all([existing.data, local.blob].map(async blob => new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))));
          if (!hashes[0].every((byte, index) => byte === hashes[1][index])) throw new Error('Tệp trên máy chủ chưa khớp. Vui lòng gỡ và chọn lại tệp.');
        }
      }
      if (key !== scopeKey(getContext()) || epoch !== lifecycle) throw new Error('Phiên làm việc đã thay đổi.');
      local.uploaded = true;
    }
  }
  async function commit(next, previous) {
    const removed = previous.filter(file => !next.some(item => item.path === file.path));
    const c = getContext();
    // Metadata has saved successfully before superseded objects are removed.
    try {
      if (c.demoMode) await Promise.all(removed.map(file => store('delete', file.path)));
      else if (removed.length) await c.client.storage.from(bucket).remove(removed.map(file => file.path));
    } catch { /* The saved homework stays usable if orphan cleanup must wait. */ }
    for (const file of removed) forget(file);
  }
  function forget(file) {
    const cached = urls.get(file.path); if (cached?.local) URL.revokeObjectURL(cached.url);
    urls.delete(file.path); memory.delete(file.path); known.delete(file.id);
  }
  function reset() {
    ++lifecycle;
    for (const value of urls.values()) if (value.local) URL.revokeObjectURL(value.url);
    urls.clear(); memory.clear(); known.clear();
  }
  async function download(id) {
    const file = known.get(id); if (!file) return;
    const key = scopeKey(getContext()), epoch = lifecycle;
    try {
      const url = await getUrl(file), c = getContext();
      if (key !== scopeKey(c) || epoch !== lifecycle) return;
      if (c.demoMode || memory.has(file.path)) {
        const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
      } else {
        // Storage download returns an authorized Blob, retaining the original filename.
        const result = await c.client.storage.from(bucket).download(file.path);
        if (key !== scopeKey(getContext()) || epoch !== lifecycle) return;
        if (result.error || !(result.data instanceof Blob)) throw new Error('Chưa tải được tệp. Vui lòng thử lại.');
        const blobUrl = URL.createObjectURL(result.data), a = document.createElement('a');
        a.href = blobUrl; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
      }
    } catch (problem) { onError(problem.message || 'Chưa tải được tệp.'); }
  }
  return { normalize, select, render, hydrate, prepare, commit, download, forget, reset };
};
