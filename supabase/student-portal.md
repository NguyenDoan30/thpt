# Cổng học sinh

Script này chạy sau `sync.sql`, `teacher-portal.sql` và `teacher-homework.sql` trong SQL Editor Supabase, bằng role `postgres`. Chạy toàn bộ file một lần; có thể chạy lại sau này.

## Cấp tài khoản

1. Giữ tắt đăng ký công khai trong Supabase Auth.
2. Tạo email và mật khẩu học sinh tại Authentication → Users; xác nhận email.
3. Trong cổng quản lý, mở lớp → hồ sơ học sinh và nhập đúng email vào **Email đăng nhập học sinh**.
4. Đợi dữ liệu báo **Đã đồng bộ**, rồi học sinh đăng nhập ở [Cổng học sinh](https://nguyendoan30.github.io/thpt/student-site/).

Hồ sơ mẫu không thể đăng nhập. Mỗi email chỉ được gắn với một hồ sơ trong cùng năm học. Email phải trùng với email tài khoản Supabase đã xác nhận. Nếu chuyển học sinh sang năm học mới bằng chức năng sao chép dữ liệu, email được giữ theo hồ sơ.

## Quyền dữ liệu

Các hàm RPC kiểm tra email của phiên Supabase đã xác nhận, đối chiếu với hồ sơ thật trong năm học được chọn, rồi chỉ trả về một học sinh, lớp, lịch, bài tập, bài kiểm tra và điểm của em đó. Không trả số CCCD hoặc hồ sơ học sinh khác. Không cấp quyền đọc trực tiếp cho bảng workspace, homework hay gradebook.

Tệp đính kèm tiếp tục nằm trong bucket riêng tư. Quyền Storage cho phép học sinh chỉ tạo liên kết tải tạm thời khi tệp được đính kèm vào bài của đúng lớp mình. Học sinh không được tải lên, thay thế hoặc xóa tệp.

Nếu chạy lại `teacher-homework.sql` sau khi đã cài cổng học sinh, hãy chạy lại file này để áp dụng lại chính sách đọc tệp dành cho học sinh.
