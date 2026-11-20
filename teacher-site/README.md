# Website giáo viên độc lập

Địa chỉ đã xuất bản: https://thpt-le-quy-don-giao-vien.twinmonk2.chatgpt.site/

Sites project ID: `appgprj_6af2efcc322c8191a15ffb6f99742655`. Giữ nguyên ID này khi cập nhật website; không tạo Site mới.

Thư mục này giữ mã nguồn giáo viên để kiểm thử và tiếp tục phát triển. Website quản lý loại thư mục này khỏi GitHub Pages bằng `_config.yml`. Website giáo viên được xuất bản riêng trên Sites, với các tệp ở đây nằm trong thư mục `dist` của dự án `/workspace/sites/thpt-giao-vien`.

Hai website cùng dùng cấu hình Supabase công khai. Tài khoản quản lý cấp quyền cho tài khoản giáo viên qua các RPC trong `supabase/teacher-portal.sql`; không sao chép dữ liệu học sinh vào mã nguồn hoặc website tĩnh. Tính năng **Giao bài tập** dùng thêm bảng và RPC trong `supabase/teacher-homework.sql`; chạy script này sau `sync.sql` và `teacher-portal.sql` trước khi dùng tài khoản thật. Xem `supabase/teacher-portal.md` để biết phạm vi quyền và cách thiết lập.

Bản demo: https://thpt-le-quy-don-giao-vien.twinmonk2.chatgpt.site/?demo=1

Demo dùng dữ liệu mẫu. Có thể chỉnh sửa hồ sơ, thời khóa biểu, điểm và bài tập; thay đổi chỉ lưu trong trình duyệt hiện tại, không gửi lên Supabase.

Trang chủ là màn hình mặc định khi đăng nhập hoặc mở demo, hiển thị lời chào, hai ô thống kê lớp giảng dạy và tiết dạy, cùng lối vào **Giao bài tập**. Hai ô **Hồ sơ học sinh** và **Lớp chủ nhiệm** đã được bỏ. Mục **Giao bài tập** cho phép tạo, xem, sửa và sao chép bài tập theo lớp, môn và năm học. Các mục Lịch dạy, Lớp phụ trách và Hồ sơ của tôi chỉ hiển thị nội dung riêng. Mã trong thư mục này được đồng bộ từ bản website giáo viên đã xuất bản.
