/* Preserve old teacher links without hosting another login in the management site. */
(() => {
  'use strict';
  const address = window.schoolTeacherPortalUrl?.();
  const status = document.getElementById('teacherRedirectStatus');
  if (!address) {
    status.textContent = 'Liên hệ nhà trường để nhận địa chỉ website giáo viên mới.';
    return;
  }
  const link = document.getElementById('teacherWebsiteLink');
  link.href = address; link.hidden = false;
  status.textContent = 'Đang chuyển sang website riêng dành cho giáo viên…';
  window.location.replace(address);
})();
