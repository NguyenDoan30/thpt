# Website giáo viên độc lập

Địa chỉ đã xuất bản: https://thpt-le-quy-don-giao-vien.twinmonk2.chatgpt.site/

Sites project ID: `appgprj_6af2efcc322c8191a15ffb6f99742655`. Giữ nguyên ID này khi cập nhật website; không tạo Site mới.

Thư mục này giữ mã nguồn giáo viên để kiểm thử và tiếp tục phát triển. Website quản lý loại thư mục này khỏi GitHub Pages bằng `_config.yml`. Website giáo viên được xuất bản riêng trên Sites, với các tệp ở đây nằm trong thư mục `dist` của dự án `/workspace/sites/thpt-giao-vien`.

Hai website cùng dùng cấu hình Supabase công khai. Tài khoản quản lý cấp quyền cho tài khoản giáo viên qua các RPC trong `supabase/teacher-portal.sql`; không sao chép dữ liệu học sinh vào mã nguồn hoặc website tĩnh.

Bản demo: https://thpt-le-quy-don-giao-vien.twinmonk2.chatgpt.site/?demo=1

Demo dùng dữ liệu mẫu. Có thể chỉnh sửa hồ sơ và thời khóa biểu; thay đổi chỉ lưu trong trình duyệt hiện tại, không gửi lên Supabase.

Trang chủ là màn hình mặc định khi đăng nhập hoặc mở demo. Trang hiển thị tổng quan, lịch dạy hôm nay theo múi giờ Việt Nam, các lớp phụ trách và nút mở nhanh lịch tuần, danh sách lớp, hồ sơ. Mã trong thư mục này được đồng bộ từ bản website giáo viên đã xuất bản.
