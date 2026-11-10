# Trang giáo viên

Chạy toàn bộ `teacher-portal.sql` trong Supabase → SQL Editor → New query → Run,
sau khi đã chạy `sync.sql`. Tệp có thể chạy lại; dữ liệu trường học đang lưu
không bị thay thế.

1. Trong Supabase → Authentication → Users, tạo một tài khoản riêng cho giáo viên
   bằng email và mật khẩu. Xác nhận email khi tạo tài khoản. Đăng ký công khai
   có thể tiếp tục tắt.
2. Đăng nhập trang quản lý, chờ trạng thái **Đã đồng bộ**, rồi liên kết email
   tài khoản vừa tạo với đúng hồ sơ giáo viên trong phần quản lý quyền truy cập.
3. Giáo viên mở `teacher.html` và đăng nhập bằng tài khoản riêng đó. Nếu có quyền
   ở nhiều trường, giáo viên chọn trường muốn xem.

Không dùng tài khoản quản lý làm tài khoản giáo viên. Không gửi mật khẩu hoặc
khóa bí mật qua trò chuyện hay đưa vào mã website.

## Phạm vi dữ liệu

Giáo viên chỉ được xem lớp đang được phân công hoặc chủ nhiệm, lịch dạy của mình
và danh sách học sinh của các lớp đó theo năm học đã chọn. Danh sách học sinh
không trả về CCCD. Trang giáo viên chỉ đọc; thay đổi từ trang quản lý được tải
lại từ dữ liệu đã đồng bộ.

Mỗi liên kết gắn một tài khoản với một hồ sơ giáo viên tại một trường. Khi đổi
email liên kết, tài khoản cũ mất quyền. Thu hồi liên kết, xóa hồ sơ hoặc chuyển
trạng thái giáo viên sang đã nghỉ hưu/đã chuyển công tác sẽ ngăn lần đọc tiếp
theo. Các trang không thể xóa dữ liệu mà người dùng đã xem hoặc tải trước đó.

## API

Các hàm chỉ cho `authenticated` gọi, yêu cầu `auth.uid()` hợp lệ và dùng
`SECURITY DEFINER` với `search_path` rỗng:

- `manage_teacher_access(p_teacher_name, p_email, p_enabled)` quản lý liên kết
  trong trường của tài khoản đang gọi. Cấp quyền yêu cầu email tài khoản đã
  xác nhận và hồ sơ giáo viên đang giảng dạy. Thu hồi theo tên hồ sơ, kể cả khi
  hồ sơ đã bị xóa hoặc email thay đổi.
- `list_school_teacher_access()` chỉ liệt kê liên kết do tài khoản đang gọi sở hữu.
- `list_teacher_schools()` chỉ liệt kê trường có liên kết còn hợp lệ của giáo viên.
- `get_teacher_portal(p_owner_id, p_year)` trả về `school`, `teacher`, `years`,
  `current`, `classes`, `assignments`, `schedule`, `studentProfiles`, `revision`,
  `updated_at`. Mọi bản ghi đều được lọc và giới hạn trường dữ liệu ở máy chủ.

Bảng liên kết không cấp quyền đọc/ghi trực tiếp cho trình duyệt. Chính sách đọc
riêng tài khoản trên `school_workspaces` giữ nguyên; giáo viên không nhận toàn
bộ bản dữ liệu của tài khoản quản lý. Một tài khoản giáo viên có thể được liên
kết với nhiều trường, nhưng chỉ một hồ sơ tại mỗi trường.
