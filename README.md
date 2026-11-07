# Cổng quản lý THPT An Bình

Website tĩnh quản lý lớp học, giáo viên bộ môn, thời khóa biểu và thành tích học sinh.

## Mở website

Phục vụ thư mục bằng HTTP/HTTPS, chẳng hạn `python -m http.server 8000`, rồi mở `http://localhost:8000`. Không cần build. Đăng nhập cần kết nối Internet và dự án Supabase đã cấu hình.

## Đăng nhập dùng chung trên nhiều thiết bị

Màn hình đăng nhập dùng Supabase Auth để xác thực email và mật khẩu. Không có tài khoản hoặc mật khẩu mặc định. Khi chưa cấu hình dịch vụ hoặc không xác minh được phiên với máy chủ, trang quản lý không mở.

1. Tạo một dự án tại [Supabase Dashboard](https://supabase.com/dashboard).
2. Trong phần Authentication, **tắt cho phép người dùng tự đăng ký**. Chỉ quản trị viên cấp tài khoản được phép vào cổng quản lý.
3. Trong Authentication → Users, tạo tài khoản email/mật khẩu cho người được phép sử dụng. Quản lý mật khẩu trong Supabase; không ghi mật khẩu vào mã nguồn hoặc gửi trong chat.
4. Đặt Site URL của dự án thành `https://nguyendoan30.github.io/thpt/`.
5. Lấy Project URL và **Publishable key** công khai trong cấu hình API của dự án, điền vào `auth-config.js`. Khóa `anon` cũ cũng được hỗ trợ. **Không** dùng khóa `service_role`, `sb_secret_…`, mật khẩu cơ sở dữ liệu hoặc khóa bí mật trong website công khai.
6. Triển khai các tệp `index.html`, `auth-config.js`, `auth.js` cùng nhau. Kiểm tra đăng nhập bằng tài khoản đã cấp trên máy tính và điện thoại.

Thư viện Supabase được ghim phiên bản và có kiểm tra toàn vẹn khi tải. Phiên đăng nhập được dịch vụ quản lý; nút **Đăng xuất** đóng giao diện và đăng xuất trên thiết bị hiện tại.

Tài khoản dùng chung giữa các thiết bị, nhưng dữ liệu lớp, học sinh, ảnh đại diện và tên trường hiện **vẫn lưu riêng trong trình duyệt**. Đăng nhập không tự đồng bộ hoặc mã hóa dữ liệu cục bộ, cũng không biến các tệp tĩnh thành dữ liệu riêng trên máy chủ. Để quản lý dữ liệu dùng chung cho toàn trường, cần thêm cơ sở dữ liệu/API có phân quyền phía máy chủ.

## Tính năng

- Thêm, sửa, xóa lớp; kiểm tra sĩ số từ 0 đến 60 học sinh.
- Lưu giáo viên chủ nhiệm và phòng học cho từng lớp.
- Phân công, cập nhật, xóa giáo viên bộ môn theo lớp.
- Xếp, sửa, xóa tiết học theo lớp, thứ và tiết; chặn trùng khung giờ.
- Vinh danh học sinh theo kỳ thi, môn học, điểm và danh hiệu.
- Tự lên lớp theo khóa tuyển sinh: lớp 10 → 11 → 12, tốt nghiệp từ năm học thứ tư.
- Bấm ảnh đại diện cạnh tên trường để chọn ảnh từ thiết bị; ảnh được lưu trên trình duyệt và dùng chung giữa các năm học.
- Lưu dữ liệu trên trình duyệt bằng `localStorage`.

## Theo dõi khóa học qua các năm

Tạo năm học ở nút **Năm học** và giữ chọn **Sao chép từ năm học đang xem** để chuyển tiếp các khóa. Khối và tên lớp tự cập nhật theo năm đích, kể cả khi tạo năm học cách quãng. Thêm lớp 10 và nhập sĩ số để ghi nhận tuyển sinh mới; quy mô theo khối và tổng học sinh chỉ cộng các lớp còn học.

Ví dụ, khóa vào lớp 10 năm 2026 học khối 11 năm 2027, khối 12 năm 2028 và vẫn được tính trong năm học 2028–2029. Từ năm học 2029–2030, khóa được ghi **Đã tốt nghiệp** và không tính vào quy mô đang học. Lớp và hồ sơ học sinh tốt nghiệp vẫn được giữ trong danh sách để tra cứu; dữ liệu từng năm học được lưu riêng.

Lớp đã có được gắn cố định với khóa tuyển sinh; khối tự thay đổi khi chuyển năm học. Với dữ liệu cũ chưa có thông tin khóa, hệ thống suy ra từ khối và năm học đầu tiên lưu lớp đó. Thời khóa biểu và thành tích không sao chép sang năm mới; phân công chỉ chuyển tiếp cho lớp còn học.

## Kiểm tra luồng lên lớp

Cần Node.js, gói `playwright` và Chromium. Chạy `node tests/cohort-lifecycle.cjs`; đặt `CHROMIUM_PATH` nếu Chromium không ở `/usr/bin/chromium`. Kiểm thử dùng dữ liệu giả trong trình duyệt riêng, không thay đổi dữ liệu đang sử dụng. Đặt `COHORT_TEST_ARTIFACT_DIR` để lưu ảnh kiểm tra.

Chạy `node tests/school-avatar.cjs` để kiểm tra chọn ảnh, lưu ảnh đại diện, tải lại và xử lý tệp không hợp lệ. Ảnh được xử lý ngay trên thiết bị, không tải lên máy chủ.

Chạy `node tests/shared-login.cjs` để kiểm tra đăng nhập, khôi phục phiên, đăng xuất và lỗi dịch vụ. Kiểm thử dùng SDK Supabase thật với các phản hồi xác thực giả lập; không cần tài khoản thật. Bộ kiểm thử tải SDK ghim phiên bản vào bộ nhớ đệm ở lần chạy đầu tiên, hoặc nhận đường dẫn SDK qua `SUPABASE_TEST_SDK_PATH`.

## Lưu ý về dữ liệu

Website hiện dùng dữ liệu mẫu và lưu thay đổi trong trình duyệt đang mở. Dữ liệu không tự đồng bộ giữa các máy hoặc tài khoản. Để vận hành cho toàn trường, cần bổ sung máy chủ/API và cơ sở dữ liệu dùng chung.

Có thể cấu hình GitHub Pages trong **Settings → Pages** để phục vụ website tĩnh từ nhánh `main`, thư mục gốc.
