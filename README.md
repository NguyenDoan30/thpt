# Cổng quản lý THPT An Bình

Website tĩnh quản lý lớp học, giáo viên bộ môn, thời khóa biểu và thành tích học sinh.

## Mở website

Mở `index.html` bằng trình duyệt. Không cần cài đặt hoặc build.

## Tính năng

- Thêm, sửa, xóa lớp; kiểm tra sĩ số từ 0 đến 60 học sinh.
- Lưu giáo viên chủ nhiệm và phòng học cho từng lớp.
- Phân công, cập nhật, xóa giáo viên bộ môn theo lớp.
- Xếp, sửa, xóa tiết học theo lớp, thứ và tiết; chặn trùng khung giờ.
- Vinh danh học sinh theo kỳ thi, môn học, điểm và danh hiệu.
- Tự lên lớp theo khóa tuyển sinh: lớp 10 → 11 → 12, tốt nghiệp từ năm học thứ tư.
- Lưu dữ liệu trên trình duyệt bằng `localStorage`.

## Theo dõi khóa học qua các năm

Tạo năm học ở nút **Năm học** và giữ chọn **Sao chép từ năm học đang xem** để chuyển tiếp các khóa. Khối và tên lớp tự cập nhật theo năm đích, kể cả khi tạo năm học cách quãng. Thêm lớp 10 và nhập sĩ số để ghi nhận tuyển sinh mới; quy mô theo khối và tổng học sinh chỉ cộng các lớp còn học.

Ví dụ, khóa vào lớp 10 năm 2026 học khối 11 năm 2027, khối 12 năm 2028 và vẫn được tính trong năm học 2028–2029. Từ năm học 2029–2030, khóa được ghi **Đã tốt nghiệp** và không tính vào quy mô đang học. Lớp và hồ sơ học sinh tốt nghiệp vẫn được giữ trong danh sách để tra cứu; dữ liệu từng năm học được lưu riêng.

Lớp đã có được gắn cố định với khóa tuyển sinh; khối tự thay đổi khi chuyển năm học. Với dữ liệu cũ chưa có thông tin khóa, hệ thống suy ra từ khối và năm học đầu tiên lưu lớp đó. Thời khóa biểu và thành tích không sao chép sang năm mới; phân công chỉ chuyển tiếp cho lớp còn học.

## Kiểm tra luồng lên lớp

Cần Node.js, gói `playwright` và Chromium. Chạy `node tests/cohort-lifecycle.cjs`; đặt `CHROMIUM_PATH` nếu Chromium không ở `/usr/bin/chromium`. Kiểm thử dùng dữ liệu giả trong trình duyệt riêng, không thay đổi dữ liệu đang sử dụng. Đặt `COHORT_TEST_ARTIFACT_DIR` để lưu ảnh kiểm tra.

## Lưu ý về dữ liệu

Website hiện dùng dữ liệu mẫu và lưu thay đổi trong trình duyệt đang mở. Dữ liệu không tự đồng bộ giữa các máy hoặc tài khoản. Để vận hành cho toàn trường, cần bổ sung máy chủ/API và cơ sở dữ liệu dùng chung.

Có thể cấu hình GitHub Pages trong **Settings → Pages** để phục vụ website tĩnh từ nhánh `main`, thư mục gốc.
