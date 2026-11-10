/* Public address of the independently hosted teacher website. */
window.SCHOOL_PORTAL_CONFIG = {
  teacherUrl: 'https://thpt-le-quy-don-giao-vien.twinmonk2.chatgpt.site/'
};

window.schoolTeacherPortalUrl = function () {
  try {
    const address = new URL(window.SCHOOL_PORTAL_CONFIG.teacherUrl);
    if (address.protocol !== 'https:' || address.username || address.password || address.origin === window.location.origin) return null;
    return address.href;
  } catch (_) { return null; }
};
