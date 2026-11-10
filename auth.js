(() => {
  'use strict';

  const MANUAL_LOCK_KEY = 'thpt-school-auth-manually-locked-v1';

  function start() {
    const app = document.getElementById('appRoot');
    const screen = document.getElementById('authScreen');
    const form = document.getElementById('loginForm');
    const email = document.getElementById('loginEmail');
    const password = document.getElementById('loginPassword');
    const submit = document.getElementById('loginSubmit');
    const errorBox = document.getElementById('loginError');
    const status = document.getElementById('loginStatus');
    const toggle = document.getElementById('loginPasswordToggle');
    const retry = document.getElementById('loginRetry');
    const logout = document.getElementById('logoutButton');
    const accountName = document.getElementById('currentAccountName');
    const hooks = window.schoolAppAuthHooks;
    if (!app || !screen || !form || !hooks) return;

    let client = null;
    let subscription = null;
    let ready = false;
    let busy = false;
    let operation = '';
    let revision = 0;
    let currentUserId = null;
    let expectedUserId = null;
    let expiryTimer = null;
    let expiryDeadline = 0;
    let retryMode = 'session';
    let manuallyLocked = false;
    try { manuallyLocked = sessionStorage.getItem(MANUAL_LOCK_KEY) === '1'; } catch (error) {}

    const showError = message => {
      errorBox.textContent = message || '';
      errorBox.hidden = !message;
    };
    const showStatus = message => { status.textContent = message || ''; };
    const showRetry = (mode, label = 'Thử lại') => {
      retryMode = mode;
      retry.textContent = label;
      retry.hidden = !mode;
    };
    const setBusy = value => {
      busy = value;
      form.setAttribute('aria-busy', String(value));
      email.disabled = password.disabled = toggle.disabled = submit.disabled = value || !ready;
      retry.disabled = logout.disabled = value;
    };
    const clearPassword = () => {
      password.value = '';
      password.type = 'password';
      toggle.setAttribute('aria-pressed', 'false');
      toggle.setAttribute('aria-label', 'Hiện mật khẩu');
      toggle.textContent = 'Hiện';
    };
    const rememberManualLock = locked => {
      manuallyLocked = locked;
      try {
        if (locked) sessionStorage.setItem(MANUAL_LOCK_KEY, '1');
        else sessionStorage.removeItem(MANUAL_LOCK_KEY);
      } catch (error) {}
    };
    const clearExpiryTimer = () => {
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      expiryTimer = null;
      expiryDeadline = 0;
    };
    const lockApp = () => {
      clearExpiryTimer();
      app.hidden = true;
      app.setAttribute('inert', '');
      app.setAttribute('aria-hidden', 'true');
      screen.hidden = false;
      screen.removeAttribute('inert');
      screen.setAttribute('aria-hidden', 'false');
      currentUserId = null;
      expectedUserId = null;
      accountName.textContent = '';
      clearPassword();
      hooks.lock();
    };
    const unlockApp = async (user, session, attempt) => {
      expectedUserId = user.id;
      if (currentUserId !== user.id || app.hidden) {
        showStatus('Đang tải dữ liệu đã đồng bộ…');
        let deadline;
        try {
          await Promise.race([
            hooks.prepare(user, client),
            new Promise((_, reject) => { deadline = setTimeout(() => reject({status: 401}), Math.max(0, sessionExpiresAt(session) - Date.now())); }),
          ]);
        } catch (error) { if (error && !error.status) error.syncFailure = true; throw error; }
        finally { clearTimeout(deadline); }
      }
      if (attempt !== revision || manuallyLocked || sessionExpiresAt(session) <= Date.now()) { if (attempt === revision) throw {status: 401}; return; }
      if (currentUserId !== user.id || app.hidden) hooks.unlock(user);
      currentUserId = user.id;
      accountName.textContent = user.email || 'Quản trị viên';
      screen.hidden = true;
      screen.setAttribute('inert', '');
      screen.setAttribute('aria-hidden', 'true');
      app.hidden = false;
      app.removeAttribute('inert');
      app.setAttribute('aria-hidden', 'false');
      clearPassword();
      showError('');
      showStatus('');
      showRetry('');
      armExpiryTimer(session);
    };

    function sessionExpiresAt(session) {
      const candidates = [Number(session && session.expires_at) * 1000];
      try {
        const payload = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        candidates.push(Number(JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).exp) * 1000);
      } catch (error) {}
      const valid = candidates.filter(value => Number.isFinite(value) && value > 0);
      return valid.length ? Math.min(...valid) : 0;
    }

    function armExpiryTimer(session) {
      clearExpiryTimer();
      const deadline = sessionExpiresAt(session);
      expiryDeadline = deadline;
      // SDK refresh retries can outlive an expired token while offline. The app
      // must lock at the verified token deadline independently of SDK events.
      expiryTimer = setTimeout(() => {
        if (expiryDeadline !== deadline || currentUserId === null) return;
        if (Date.now() < deadline) { armExpiryTimer(session); return; }
        expireSession();
      }, Math.max(0, Math.min(deadline - Date.now(), 2147483647)));
    }

    function expireSession() {
      if (!expiryDeadline || Date.now() < expiryDeadline || currentUserId === null) return;
      ++revision;
      operation = '';
      lockApp();
      setBusy(false);
      showError('');
      showRetry('');
      if (ready && !manuallyLocked) {
        checkSession();
        if (busy) showStatus('Phiên đăng nhập đã hết hạn. Đang kiểm tra lại…');
      } else showStatus('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    }

    function messageFor(error) {
      if (error && error.syncFailure) return error.message || 'Không tải được dữ liệu đồng bộ. Vui lòng thử lại.';
      const code = String(error && error.code || '');
      const statusCode = Number(error && error.status);
      if (code === 'invalid_credentials' || code === 'invalid_grant') return 'Email hoặc mật khẩu chưa đúng.';
      if (code === 'email_not_confirmed') return 'Tài khoản chưa được xác nhận. Vui lòng liên hệ quản trị viên.';
      if (code === 'user_banned') return 'Tài khoản đang bị khóa. Vui lòng liên hệ quản trị viên.';
      if (statusCode === 429 || code.includes('rate_limit')) return 'Bạn đã thử quá nhiều lần. Vui lòng chờ một lúc rồi đăng nhập lại.';
      if (statusCode === 401 || statusCode === 403 || code === 'session_not_found' || code === 'refresh_token_not_found') return 'Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.';
      return 'Không kết nối được dịch vụ đăng nhập. Kiểm tra kết nối mạng rồi thử lại.';
    }

    function readConfiguration() {
      const config = window.SCHOOL_AUTH_CONFIG || {};
      const url = String(config.supabaseUrl || '').trim();
      const key = String(config.publishableKey || '').trim();
      if (!url || !key) throw new Error('Chưa cấu hình dịch vụ đăng nhập. Quản trị viên cần thiết lập Supabase URL và khóa công khai trong auth-config.js.');
      let parsed;
      try { parsed = new URL(url); } catch (error) { throw new Error('Supabase URL chưa hợp lệ. Vui lòng kiểm tra auth-config.js.'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
        throw new Error('Supabase URL phải là địa chỉ HTTPS của dự án, không kèm đường dẫn hoặc thông tin đăng nhập.');
      }
      let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
      if (!publicKey && key.split('.').length === 3) {
        try {
          const payload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
          publicKey = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).role === 'anon';
        } catch (error) {}
      }
      if (!publicKey) throw new Error('Chỉ sử dụng Supabase Publishable key hoặc khóa anon công khai. Không sử dụng Secret key hay service_role key.');
      return { url: parsed.origin, key };
    }

    async function verifiedUser(session) {
      if (!session || !session.access_token) throw { status: 401 };
      if (sessionExpiresAt(session) <= Date.now()) throw { status: 401 };
      const result = await client.auth.getUser(session.access_token);
      if (result.error) throw result.error;
      if (!result.data || !result.data.user || !result.data.user.id) throw { status: 401 };
      if (sessionExpiresAt(session) <= Date.now()) throw { status: 401 };
      return result.data.user;
    }

    async function checkSession(session) {
      if (!ready || busy || manuallyLocked) return;
      const attempt = ++revision;
      operation = 'check';
      setBusy(true);
      showError('');
      showStatus('Đang kiểm tra phiên đăng nhập…');
      showRetry('');
      try {
        if (!session) {
          const result = await client.auth.getSession();
          if (result.error) throw result.error;
          session = result.data.session;
        }
        if (attempt !== revision || manuallyLocked) return;
        if (!session) {
          lockApp();
          showStatus('Đăng nhập bằng tài khoản do quản trị viên cấp.');
          return;
        }
        expectedUserId = session.user && session.user.id || null;
        const user = await verifiedUser(session);
        if (attempt !== revision || manuallyLocked) return;
        await unlockApp(user, session, attempt);
      } catch (error) {
        if (attempt !== revision) return;
        lockApp();
        showStatus('');
        showError(messageFor(error));
        showRetry('session');
      } finally {
        if (attempt === revision) { operation = ''; setBusy(false); }
      }
    }

    function handleAuthState(event, session) {
      if (event === 'INITIAL_SESSION') return;
      if (event === 'SIGNED_OUT') {
        if (operation === 'sign-out') return;
        ++revision;
        rememberManualLock(true);
        lockApp();
        operation = '';
        setBusy(false);
        showError('');
        showRetry('');
        showStatus('Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.');
        return;
      }
      if (session && ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event)) {
        const incoming = session.user && session.user.id;
        const active = expectedUserId || currentUserId;
        if (incoming && active && incoming !== active) {
          ++revision;
          lockApp();
          expectedUserId = incoming;
          operation = '';
          setBusy(false);
          showError('');
          showStatus('Tài khoản đã thay đổi. Đang kiểm tra lại…');
          setTimeout(() => { if (!busy && !manuallyLocked) checkSession(session); }, 0);
          return;
        }
        if (!expectedUserId && incoming) expectedUserId = incoming;
        // Supabase calls listeners while holding its auth lock. Validate afterward.
        setTimeout(() => { if (!busy && !manuallyLocked) checkSession(session); }, 0);
      }
    }

    async function initialize() {
      ++revision;
      ready = false;
      lockApp();
      setBusy(true);
      showError('');
      showStatus('Đang kết nối dịch vụ đăng nhập…');
      showRetry('');
      try {
        const config = readConfiguration();
        if (!window.supabase || typeof window.supabase.createClient !== 'function') {
          throw new Error('Không tải được dịch vụ đăng nhập. Kiểm tra kết nối mạng rồi thử lại.');
        }
        if (subscription) subscription.unsubscribe();
        if (client) await client.auth.stopAutoRefresh();
        client = window.supabase.createClient(config.url, config.key, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        });
        subscription = client.auth.onAuthStateChange(handleAuthState).data.subscription;
        ready = true;
        setBusy(false);
        if (manuallyLocked) showStatus('Đăng nhập bằng tài khoản do quản trị viên cấp.');
        else await checkSession();
      } catch (error) {
        ready = false;
        lockApp();
        setBusy(false);
        showStatus('');
        showError(error.message || 'Không khởi tạo được dịch vụ đăng nhập.');
        showRetry('initialize');
      }
    }

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!ready || busy) return;
      const address = email.value.trim();
      const secret = password.value;
      if (!address || !secret) { showError('Vui lòng nhập email và mật khẩu.'); return; }
      const attempt = ++revision;
      operation = 'sign-in';
      setBusy(true);
      showError('');
      showRetry('');
      showStatus('Đang đăng nhập…');
      try {
        const result = await client.auth.signInWithPassword({ email: address, password: secret });
        if (result.error) throw result.error;
        expectedUserId = result.data.session && result.data.session.user && result.data.session.user.id || null;
        const user = await verifiedUser(result.data.session);
        if (attempt !== revision) return;
        rememberManualLock(false);
        await unlockApp(user, result.data.session, attempt);
      } catch (error) {
        if (attempt !== revision) return;
        lockApp();
        showStatus('');
        showError(messageFor(error));
        if (error && error.syncFailure) showRetry('session');
      } finally {
        if (attempt === revision) { operation = ''; setBusy(false); }
      }
    });

    async function signOut() {
      if (!client || busy) return;
      const attempt = ++revision;
      operation = 'sign-out';
      rememberManualLock(true);
      lockApp();
      setBusy(true);
      showError('');
      showRetry('');
      showStatus('Đang đăng xuất…');
      try {
        const result = await client.auth.signOut({ scope: 'local' });
        if (result.error) throw result.error;
        if (attempt === revision) showStatus('Bạn đã đăng xuất.');
      } catch (error) {
        if (attempt !== revision) return;
        showStatus('');
        showError('Màn hình đã khóa nhưng chưa kết thúc được phiên với máy chủ. Kiểm tra kết nối rồi thử đăng xuất lại.');
        showRetry('sign-out', 'Thử đăng xuất lại');
      } finally {
        if (attempt === revision) { operation = ''; setBusy(false); }
      }
    }

    toggle.addEventListener('click', () => {
      const show = password.type === 'password';
      password.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
      toggle.textContent = show ? 'Ẩn' : 'Hiện';
    });
    logout.addEventListener('click', signOut);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) expireSession(); });
    window.addEventListener('pageshow', expireSession);
    retry.addEventListener('click', () => {
      if (retryMode === 'sign-out') signOut();
      else if (retryMode === 'initialize') {
        if (!window.supabase) window.location.reload();
        else initialize();
      } else checkSession();
    });

    initialize();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
