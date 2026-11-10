/* Account-scoped workspace synchronization. Uses the official Supabase client supplied by auth.js. */
(function (global) {
  'use strict';
  const CACHE_PREFIX = 'thpt-school-sync-cache-v1:';
  const OWNER_KEY = 'thpt-school-sync-owner-v1';
  const BACKUP_KEY = 'thpt-school-sync-legacy-backup-v1';
  const ABSENT = Symbol('absent');
  const copy = value => value === ABSENT ? ABSENT : value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function equal(a, b) {
    if (a === b) return true;
    if (a === ABSENT || b === ABSENT || !a || !b || typeof a !== typeof b) return false;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
    if (!object(a) || !object(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
  }
  function identityFor(arrays, path) {
    const values = arrays.flat();
    if (!values.length) return value => JSON.stringify(value);
    let identify;
    if (values.every(value => object(value) && value.id !== undefined && value.id !== null && value.id !== '')) identify = value => 'id:' + String(value.id);
    else if (/(^|\.)teachers$/.test(path) && values.every(value => object(value) && typeof value.name === 'string')) identify = value => 'name:' + value.name.normalize('NFC').trim().toLocaleLowerCase('vi');
    else if (values.every(value => ['string', 'number', 'boolean'].includes(typeof value))) identify = value => typeof value + ':' + JSON.stringify(value);
    if (!identify || arrays.some(array => new Set(array.map(identify)).size !== array.length)) return null;
    return identify;
  }
  function merge(base, local, remote, resolution, semanticConflicts) {
    const conflicts = [];
    function visit(b, l, r, path) {
      // A selected year belongs to this device and must never prompt a data conflict.
      if (path === 'current') return copy(l);
      if (equal(l, r)) return copy(l);
      if (equal(l, b)) return copy(r);
      if (equal(r, b)) return copy(l);
      if (object(l) && object(r) && (object(b) || b === ABSENT)) {
        const out = {}, old = b === ABSENT ? {} : b;
        new Set([...Object.keys(old), ...Object.keys(l), ...Object.keys(r)]).forEach(key => {
          const value = visit(Object.prototype.hasOwnProperty.call(old, key) ? old[key] : ABSENT, Object.prototype.hasOwnProperty.call(l, key) ? l[key] : ABSENT, Object.prototype.hasOwnProperty.call(r, key) ? r[key] : ABSENT, path ? path + '.' + key : key);
          if (value !== ABSENT) out[key] = value;
        });
        return out;
      }
      if (Array.isArray(l) && Array.isArray(r) && (Array.isArray(b) || b === ABSENT)) {
        const old = b === ABSENT ? [] : b, identify = identityFor([old, l, r], path);
        if (identify) {
          const maps = [old, l, r].map(array => new Map(array.map(value => [identify(value), value]))), out = [];
          new Set([...l.map(identify), ...r.map(identify), ...old.map(identify)]).forEach(key => {
            const value = visit(...maps.map(map => map.has(key) ? map.get(key) : ABSENT), path + '[' + key + ']');
            if (value !== ABSENT) out.push(value);
          });
          return out;
        }
      }
      conflicts.push({path, base: b === ABSENT ? null : copy(b), local: l === ABSENT ? null : copy(l), remote: r === ABSENT ? null : copy(r), localDeleted: l === ABSENT, remoteDeleted: r === ABSENT});
      return copy(resolution === 'remote' ? r : l);
    }
    const snapshot = visit(base, local, remote, '');
    // Class relationships and uniqueness span several arrays, so field merging alone
    // cannot tell whether independently valid edits still form a valid class.
    const linked = ['studentProfiles', 'assignments', 'schedule'], bundles = semanticConflicts ? semanticConflicts.slice() : [];
    const rows = (record, group) => record && Array.isArray(record[group]) ? record[group] : [];
    const bundle = (state, year, classId) => {
      const record = state && state.years && state.years[year];
      return Object.fromEntries(['classes', ...linked].map(group => [group, copy(rows(record, group).filter(row => String(group === 'classes' ? row.id : row.classId) === classId))]));
    };
    const collectBundles = () => { if (object(snapshot) && object(snapshot.years)) Object.entries(snapshot.years).forEach(([year, record]) => {
      if (!object(record) || !Array.isArray(record.classes)) return;
      const classes = new Map(record.classes.map(row => [String(row.id), row])), affected = new Map(), counts = new Map();
      linked.forEach(group => rows(record, group).forEach(row => {
        if (row.classId === undefined || row.classId === null || row.classId === '') return;
        const classId = String(row.classId);
        if (!classes.has(classId)) affected.set(classId, 'missing_class');
        if (group === 'studentProfiles') counts.set(classId, (counts.get(classId) || 0) + 1);
      }));
      classes.forEach((record, classId) => {
        if (Number.isFinite(Number(record.students)) && (counts.get(classId) || 0) > Number(record.students)) affected.set(classId, 'roster_capacity');
      });
      const collisions = (group, identify, reason, classField = 'classId') => {
        const seen = new Map();
        rows(record, group).forEach(row => {
          const key = identify(row);
          if (key === null || key === '') return;
          const previous = seen.get(key);
          if (previous && String(previous.id) !== String(row.id)) [previous, row].forEach(member => {
            if (member[classField] !== undefined && member[classField] !== null && member[classField] !== '') affected.set(String(member[classField]), reason);
          });
          else seen.set(key, row);
        });
      };
      collisions('schedule', row => row.classId && Number.isFinite(Number(row.day)) && Number.isFinite(Number(row.period)) ? JSON.stringify([String(row.classId), Number(row.day), Number(row.period)]) : null, 'schedule_cell');
      collisions('studentProfiles', row => String(row.cccd || '').trim(), 'student_cccd');
      collisions('classes', row => row.name ? JSON.stringify([String(row.name).toLowerCase(), row.admissionYear]) : null, 'class_identity', 'id');
      affected.forEach((reason, classId) => { if (!bundles.some(bundle => bundle.year === year && bundle.classId === classId)) bundles.push({year, classId, reason}); });
    }); };
    collectBundles();
    for (let index = 0; index < bundles.length; index++) {
      const {year, classId, reason} = bundles[index];
      const original = bundle(base, year, classId), device = bundle(local, year, classId), cloud = bundle(remote, year, classId);
      conflicts.push({path: 'years.' + year + '.classes[id:' + classId + '].bundle', kind: 'class-bundle', year, classId, reason, base: original, local: device, remote: cloud, localDeleted: !device.classes.length, remoteDeleted: !cloud.classes.length});
      // The unresolved proposal keeps every child. Only the user's explicit choice
      // may discard records, and only inside the affected class bundle.
      if (!['local', 'remote'].includes(resolution)) continue;
      const record = snapshot && snapshot.years && snapshot.years[year], chosen = resolution === 'remote' ? cloud : device;
      if (!record) continue;
      ['classes', ...linked].forEach(group => {
        const chosenIds = new Set(chosen[group].map(row => String(row.id)));
        record[group] = rows(record, group).filter(row => String(group === 'classes' ? row.id : row.classId) !== classId && !chosenIds.has(String(row.id))).concat(copy(chosen[group]));
      });
      // Restoring one bundle can expose a collision with another merged class.
      collectBundles();
    }
    // The selected year is a device view preference, not an edit to school records.
    if (object(snapshot) && object(snapshot.years)) {
      const preferred = local && local.current;
      snapshot.current = Object.prototype.hasOwnProperty.call(snapshot.years, preferred) ? preferred : Object.prototype.hasOwnProperty.call(snapshot.years, remote && remote.current) ? remote.current : Object.keys(snapshot.years)[0];
    }
    return {snapshot, conflicts};
  }
  function businessEqual(a, b) {
    if (!a || !b) return equal(a, b);
    const l = {...a}, r = {...b}; delete l.current; delete r.current;
    return equal(l, r);
  }
  function create({client, adapter, onStatus = () => {}}) {
    if (!client || !adapter) throw new Error('Chưa cấu hình kết nối đồng bộ.');
    let userId = null, cache = null, generation = 0, aborter = null, debounce = null, poller = null, retryTimer = null;
    let running = null, needPull = false, paused = false, editVersion = 0, retryCount = 0;
    const listeners = [];
    const status = value => { try { onStatus(value); } catch (_) {} };
    const normalized = value => copy(adapter.normalize(copy(value)));
    const current = token => userId !== null && token === generation && !aborter.signal.aborted;
    const assertCurrent = token => { if (!current(token)) { const error = new Error('Phiên đồng bộ đã kết thúc.'); error.name = 'AbortError'; throw error; } };
    const key = () => CACHE_PREFIX + userId;
    const migrationKey = (owner = userId) => BACKUP_KEY + ':' + owner + ':pending';
    function persist(next) {
      // Persist before acknowledging a user edit or clearing a pending write.
      localStorage.setItem(key(), JSON.stringify(next));
      cache = next;
    }
    function rememberLegacy(snapshot) {
      const backupKey = BACKUP_KEY + ':' + userId;
      if (localStorage.getItem(backupKey) === null) localStorage.setItem(backupKey, JSON.stringify({version: 1, userId, savedAt: new Date().toISOString(), snapshot}));
    }
    function migrationLegacy(mayImport) {
      const stored = localStorage.getItem(migrationKey());
      let snapshot;
      if (stored !== null) {
        let parsed;
        try { parsed = JSON.parse(stored); } catch (_) { throw new Error('Bản sao dữ liệu đang chuyển đổi bị lỗi. Hãy giữ bản lưu và liên hệ hỗ trợ.'); }
        if (!parsed || parsed.version !== 1 || parsed.userId !== userId || !object(parsed.snapshot)) throw new Error('Bản sao dữ liệu đang chuyển đổi không hợp lệ.');
        snapshot = normalized(parsed.snapshot);
      } else if (mayImport) {
        snapshot = normalized(adapter.capture());
        // This active stage survives account switches until the main cache is durable.
        localStorage.setItem(migrationKey(), JSON.stringify({version: 1, userId, savedAt: new Date().toISOString(), snapshot}));
      } else return null;
      rememberLegacy(snapshot);
      return snapshot;
    }
    function finishMigration() {
      // A failed cleanup is harmless: an existing main cache always takes precedence.
      try { localStorage.removeItem(migrationKey()); } catch (_) {}
    }
    function ownDevice() { localStorage.setItem(OWNER_KEY, userId); }
    function friendly(error) {
      const message = String(error && error.message || error || '');
      if (/school_workspaces|save_school_workspace|PGRST20[25]|42P01|42883/i.test(message + ' ' + (error && error.code || ''))) return new Error('Máy chủ chưa được thiết lập đồng bộ dữ liệu trường học. Vui lòng chạy tệp SQL thiết lập trong Supabase rồi thử lại.');
      return error instanceof Error ? error : new Error(message || 'Không thể kết nối đồng bộ.');
    }
    function report(error, token) {
      if (!current(token) || error && error.name === 'AbortError') return;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false || /fetch|network|offline|Failed to fetch/i.test(String(error && error.message || error));
      status({state: offline ? 'offline' : 'error', message: offline ? 'Đang ngoại tuyến. Thay đổi đã được giữ trên thiết bị và sẽ tự đồng bộ khi có mạng.' : friendly(error).message});
      if (!paused && !retryTimer) {
        const delay = Math.min(30000, 1000 * Math.pow(2, retryCount++));
        retryTimer = setTimeout(() => { retryTimer = null; if (current(token)) { needPull = true; launch(); } }, delay);
      }
    }
    async function request(operation, token) {
      assertCurrent(token);
      const requestUserId = userId;
      const sessionSignal = aborter.signal, controller = new AbortController();
      let timer, cancel;
      const cancelled = new Promise((_, reject) => {
        cancel = () => {
          const error = new Error('Phiên đồng bộ đã kết thúc.'); error.name = 'AbortError';
          reject(error); controller.abort();
        };
        sessionSignal.addEventListener('abort', cancel, {once: true});
      });
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Kết nối đồng bộ mất quá nhiều thời gian. Vui lòng thử lại.'); error.name = 'TimeoutError';
          reject(error); controller.abort();
        }, 20000);
      });
      try {
        const pending = Promise.resolve().then(async () => {
          assertCurrent(token);
          let accessToken = null;
          if (client.auth && typeof client.auth.getSession === 'function') {
            const result = await client.auth.getSession();
            assertCurrent(token);
            if (result.error) throw friendly(result.error);
            const session = result.data && result.data.session;
            if (!session || !session.user || session.user.id !== requestUserId || !session.access_token) throw new Error('Phiên tài khoản đã thay đổi. Vui lòng đăng nhập lại để tiếp tục đồng bộ.');
            accessToken = session.access_token;
          }
          assertCurrent(token);
          if (controller.signal.aborted) { const error = new Error('Yêu cầu đồng bộ đã kết thúc.'); error.name = 'AbortError'; throw error; }
          let query = operation();
          if (accessToken) {
            if (!query || typeof query.setHeader !== 'function') throw new Error('Thư viện kết nối chưa hỗ trợ cố định tài khoản đồng bộ. Vui lòng tải lại trang.');
            query = query.setHeader('Authorization', 'Bearer ' + accessToken) || query;
          }
          return query && typeof query.abortSignal === 'function' ? query.abortSignal(controller.signal) : query;
        });
        const result = await Promise.race([pending, cancelled, deadline]);
        assertCurrent(token);
        return result;
      } catch (error) {
        // A transport rejection from an old session must not affect its replacement.
        assertCurrent(token);
        throw error;
      } finally {
        clearTimeout(timer);
        sessionSignal.removeEventListener('abort', cancel);
      }
    }
    async function readRemote(token, metadataOnly = false) {
      const result = await request(() => client.from('school_workspaces').select(metadataOnly ? 'revision,updated_at' : 'payload,revision,updated_at').eq('user_id', userId).maybeSingle(), token);
      if (result.error) throw friendly(result.error);
      if (!result.data) return null;
      if (!Number.isSafeInteger(Number(result.data.revision)) || Number(result.data.revision) < 1) throw new Error('Phiên bản dữ liệu đám mây không hợp lệ.');
      return {...result.data, revision: Number(result.data.revision), ...(metadataOnly ? {} : {payload: normalized(result.data.payload)})};
    }
    function withLocalView(snapshot, local) {
      const result = copy(snapshot);
      if (local && result.years && Object.prototype.hasOwnProperty.call(result.years, local.current)) result.current = local.current;
      return result;
    }
    async function decide(kind, local, remote, conflicts, token) {
      status({state: 'conflict', message: kind === 'migration' ? 'Cần chọn dữ liệu để sử dụng lần đầu trên thiết bị này.' : 'Có thay đổi đồng thời cần bạn xem lại.'});
      const answer = await adapter.choose({kind, local: copy(local), remote: copy(remote), conflicts: copy(conflicts), signal: aborter.signal});
      assertCurrent(token);
      if (!['local', 'remote'].includes(answer)) { paused = true; return 'cancel'; }
      return answer;
    }
    function apply(next, initial, token) {
      assertCurrent(token);
      if (adapter.canApply && !adapter.canApply()) return false;
      ownDevice();
      adapter.apply(copy(next), {initial: !!initial});
      assertCurrent(token);
      return true;
    }
    async function integrate(row, token, initial = false) {
      assertCurrent(token);
      if (row && cache.base && row.revision === cache.revision) return true;
      const local = copy(cache.snapshot), version = editVersion;
      let snapshot = local;
      if (row) {
        if (cache.pending) {
          const baseline = cache.base || normalized(adapter.defaultSnapshot());
          const result = merge(baseline, local, row.payload);
          if (result.conflicts.length) {
            if (adapter.canApply && !adapter.canApply()) return false;
            const answer = await decide('conflict', local, row.payload, result.conflicts, token);
            if (answer === 'cancel') return false;
            if (version !== editVersion) { needPull = true; return false; }
            snapshot = merge(baseline, local, row.payload, answer, result.conflicts.filter(conflict => conflict.kind === 'class-bundle')).snapshot;
          } else snapshot = result.snapshot;
        } else snapshot = withLocalView(row.payload, local);
      }
      snapshot = normalized(snapshot);
      const changes = initial || !equal(snapshot, local);
      if (changes && adapter.canApply && !adapter.canApply()) return false;
      persist({...cache, base: row ? copy(row.payload) : null, revision: row ? row.revision : 0, snapshot, pending: !row || !businessEqual(snapshot, row.payload), updatedAt: row && row.updated_at || null});
      // connect() performs the single initial application after integration succeeds.
      if (changes && !initial && !apply(snapshot, false, token)) { needPull = true; return false; }
      return true;
    }
    async function saveOnce(token) {
      const desired = copy(cache.snapshot), expected = cache.revision;
      status({state: 'saving', message: 'Đang lưu dữ liệu lên đám mây…'});
      const result = await request(() => client.rpc('save_school_workspace', {p_expected_revision: expected, p_payload: desired}), token);
      if (result.error) {
        if (result.error.code === 'P0001' && /sync_conflict/i.test(result.error.message || '') || /sync_conflict/i.test(result.error.message || '')) {
          const row = await readRemote(token);
          if (!await integrate(row, token)) { needPull = !paused; return false; }
          return true;
        }
        throw friendly(result.error);
      }
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!row || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) <= expected) throw new Error('Máy chủ không xác nhận được phiên bản dữ liệu đã lưu.');
      const saved = row.payload ? normalized(row.payload) : desired;
      persist({...cache, base: saved, revision: Number(row.revision), pending: !businessEqual(cache.snapshot, saved), updatedAt: row.updated_at || new Date().toISOString()});
      retryCount = 0;
      return true;
    }
    async function drive() {
      if (running) return running;
      const token = generation;
      const task = (async () => {
        assertCurrent(token);
        if (paused) return;
        if (needPull) {
          needPull = false;
          const row = await readRemote(token);
          if (!await integrate(row, token)) { needPull = !paused; return; }
        }
        // Queue calls during an RPC are coalesced into the next serialized write.
        let attempts = 0;
        while (current(token) && cache.pending && !paused) {
          if (!await saveOnce(token)) return;
          if (++attempts >= 12) { schedule(); return; }
        }
        assertCurrent(token);
        retryCount = 0;
        status({state: 'synced', updatedAt: cache.updatedAt, message: 'Đã đồng bộ'});
      })();
      running = task;
      try { await task; } finally { if (running === task) running = null; }
    }
    function launch() { if (userId) { const token = generation; drive().catch(error => report(error, token)); } }
    function schedule() {
      clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; launch(); }, 300);
    }
    async function checkRevision() {
      if (!userId || running || paused) return;
      const token = generation;
      try {
        if (needPull || cache.pending) { await drive(); return; }
        const row = await readRemote(token, true);
        if (!row || row.revision !== cache.revision) { needPull = true; await drive(); }
      } catch (error) { report(error, token); }
    }
    function listen(target, name, handler) {
      if (target && target.addEventListener) { target.addEventListener(name, handler); listeners.push(() => target.removeEventListener(name, handler)); }
    }
    function disconnect() {
      generation++;
      if (aborter) aborter.abort();
      clearTimeout(debounce); clearTimeout(retryTimer); clearInterval(poller);
      debounce = retryTimer = poller = null;
      listeners.splice(0).forEach(remove => remove());
      userId = cache = null; running = null; needPull = paused = false; retryCount = 0; editVersion++;
    }
    async function connect(user) {
      disconnect();
      if (!user || typeof user.id !== 'string' || !user.id || user.is_anonymous) throw new Error('Vui lòng đăng nhập tài khoản đã xác thực để đồng bộ.');
      userId = user.id; aborter = new AbortController();
      const token = generation;
      status({state: 'loading', message: 'Đang tải dữ liệu của tài khoản…'});
      try {
        assertCurrent(token);
        // A verified account claims unowned legacy data before any asynchronous work,
        // even when preparation is interrupted before its first application.
        const owner = localStorage.getItem(OWNER_KEY), mayImport = owner === null || owner === userId;
        if (owner === null) ownDevice();
        if (!mayImport && localStorage.getItem(CACHE_PREFIX + owner) === null && localStorage.getItem(BACKUP_KEY + ':' + owner) === null && localStorage.getItem(migrationKey(owner)) === null) throw new Error('Dữ liệu của tài khoản trước chưa có bản sao an toàn. Vui lòng đăng nhập lại tài khoản đó và sao lưu trước khi chuyển tài khoản.');
        const stored = localStorage.getItem(key());
        if (stored) {
          let parsed;
          try { parsed = JSON.parse(stored); } catch (_) { throw new Error('Bản lưu đồng bộ trên thiết bị bị lỗi. Hãy giữ bản lưu và liên hệ hỗ trợ.'); }
          if (!parsed || parsed.version !== 1 || typeof parsed.pending !== 'boolean' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0) throw new Error('Bản lưu đồng bộ trên thiết bị không hợp lệ.');
          cache = {...parsed, snapshot: normalized(parsed.snapshot), base: parsed.base ? normalized(parsed.base) : null};
        }
        // Capture and protect legacy data before a read can yield to another login.
        const stagedLegacy = cache ? null : migrationLegacy(mayImport);
        const row = await readRemote(token);
        assertCurrent(token);
        if (!cache) {
          const canImport = stagedLegacy !== null, legacy = canImport ? stagedLegacy : normalized(adapter.defaultSnapshot());
          let snapshot;
          if (!row) snapshot = legacy;
          else {
            snapshot = row.payload;
            if (canImport && adapter.isMeaningfulLegacy(legacy) && !businessEqual(legacy, row.payload)) {
              const answer = await decide('migration', legacy, row.payload, [], token);
              if (answer === 'cancel') { const error = new Error('Chưa chọn dữ liệu đồng bộ. Dữ liệu trên thiết bị vẫn được giữ nguyên.'); error.code = 'sync_cancelled'; throw error; }
              snapshot = answer === 'local' ? legacy : row.payload;
            }
          }
          snapshot = normalized(snapshot);
          if (adapter.canApply && !adapter.canApply()) throw new Error('Hãy hoàn tất biểu mẫu đang mở trước khi tải dữ liệu tài khoản.');
          persist({version: 1, base: row ? row.payload : null, revision: row ? row.revision : 0, snapshot, pending: !row || !businessEqual(snapshot, row.payload), updatedAt: row && row.updated_at || null});
          finishMigration();
          if (!apply(snapshot, true, token)) throw new Error('Chưa thể tải dữ liệu tài khoản vào biểu mẫu đang mở.');
        } else {
          if (!await integrate(row, token, true)) {
            const error = new Error(paused ? 'Chưa giải quyết xung đột đồng bộ. Thay đổi trên thiết bị vẫn được giữ nguyên.' : 'Hãy hoàn tất biểu mẫu đang mở trước khi tải dữ liệu tài khoản.'); error.code = paused ? 'sync_cancelled' : 'sync_busy'; throw error;
          }
          // An unchanged cloud revision can still need an initial cached-state application.
          if (!apply(cache.snapshot, true, token)) throw new Error('Hãy hoàn tất biểu mẫu đang mở trước khi tải dữ liệu tài khoản.');
          finishMigration();
        }
        await drive();
        assertCurrent(token);
        if (paused) { const error = new Error('Chưa giải quyết xung đột đồng bộ.'); error.code = 'sync_cancelled'; throw error; }
        ownDevice();
        const wake = () => { if (!userId || typeof document !== 'undefined' && document.visibilityState === 'hidden') return; needPull = true; if (!paused) launch(); };
        listen(global, 'online', wake); listen(global, 'focus', wake); listen(typeof document !== 'undefined' ? document : null, 'visibilitychange', wake);
        poller = setInterval(checkRevision, 5000);
      } catch (error) {
        if (current(token)) {
          if (error.code !== 'sync_cancelled') status({state: 'error', message: friendly(error).message});
          // Keep the cache, but prevent a failed initial session from writing in the background.
          disconnect();
        }
        throw friendly(error);
      }
    }
    function queue(snapshot) {
      if (!userId || !cache) throw new Error('Chưa đăng nhập để đồng bộ dữ liệu.');
      const value = normalized(snapshot);
      persist({...cache, snapshot: value, pending: !cache.base || !businessEqual(value, cache.base)});
      editVersion++;
      if (!paused) { status({state: cache.pending ? 'saving' : 'synced', updatedAt: cache.updatedAt}); schedule(); }
    }
    async function retry() {
      if (!userId) throw new Error('Vui lòng đăng nhập lại để đồng bộ.');
      const token = generation;
      paused = false; retryCount = 0; clearTimeout(retryTimer); retryTimer = null; needPull = true;
      try { await drive(); } catch (error) { report(error, token); throw error; }
    }
    async function pull() {
      if (!userId) return;
      const token = generation;
      needPull = true;
      try { await drive(); } catch (error) { report(error, token); throw error; }
    }
    return {connect, disconnect, queue, retry, pull};
  }
  global.SchoolCloudSync = {create, mergeStates: (base, local, remote) => merge(copy(base), copy(local), copy(remote)), CACHE_PREFIX, OWNER_KEY, BACKUP_KEY};
})(window);
