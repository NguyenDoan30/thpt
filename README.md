# Cổng quản lý THPT Lê Quý Đôn

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
6. Chạy một lần [mã SQL thiết lập đồng bộ](supabase/sync.sql) trong SQL Editor theo [hướng dẫn Supabase](supabase/README.md).
7. Triển khai các tệp HTML, JavaScript, CSS ở thư mục gốc và thư mục `supabase` lên website quản lý. Website giáo viên được xuất bản riêng từ thư mục `teacher-site`, không gộp vào màn hình đăng nhập quản lý. Kiểm tra đăng nhập bằng tài khoản đã cấp trên máy tính và điện thoại.

Thư viện Supabase được ghim phiên bản và có kiểm tra toàn vẹn khi tải. Phiên đăng nhập được dịch vụ quản lý; nút **Đăng xuất** đóng giao diện và đăng xuất trên thiết bị hiện tại.

## Đồng bộ giữa các thiết bị

Hai thiết bị đăng nhập **cùng một tài khoản quản lý** sẽ dùng chung toàn bộ năm học, lớp, học sinh, giáo viên, phân công, thời khóa biểu, danh mục môn học, thành tích, tên trường và ảnh đại diện. Mỗi tài khoản quản lý có dữ liệu riêng; giáo viên chỉ được xem phần dữ liệu đã được cấp quyền qua trang giáo viên.

Lần đầu sử dụng, mở website trên thiết bị đang có dữ liệu muốn giữ, đăng nhập và chờ dòng **Đã đồng bộ** trước khi mở thiết bị khác. Website giữ một bản sao dữ liệu cũ theo tài khoản; có thể tải về bằng **Tải bản sao dữ liệu cũ**. Nếu thiết bị và máy chủ đã có hai bản khác nhau, giao diện hiển thị thông tin của hai bản để chọn, không âm thầm ghi đè.

Thay đổi được lưu tự động. Thiết bị khác kiểm tra phiên bản mới mỗi 5 giây và khi quay lại trang; biểu mẫu đang nhập sẽ được giữ cho đến khi đóng. Các chỉnh sửa riêng ở hai thiết bị được gộp; nếu cùng sửa một thông tin, người dùng chọn phần cần giữ. Việc chọn năm đang xem là tùy chọn của từng thiết bị.

Khi mất mạng, các thay đổi chưa gửi được vẫn được giữ trong bản chờ trên thiết bị để gửi lại. Chỉ dòng **Đã đồng bộ** mới xác nhận máy chủ đã lưu. Không xóa dữ liệu trình duyệt khi còn thay đổi chờ; đăng nhập hoặc khôi phục phiên vẫn cần kết nối mạng.

## Trang dành cho giáo viên

Website quản lý và website giáo viên được xuất bản ở hai địa chỉ độc lập, có màn hình đăng nhập và phiên đăng nhập riêng. Màn hình quản lý không có nút chuyển sang đăng nhập giáo viên. Địa chỉ website giáo viên được khai báo công khai trong `portal-config.js`; liên kết `teacher.html` cũ chỉ chuyển tới địa chỉ mới.

- Website quản lý: https://nguyendoan30.github.io/thpt/
- Website giáo viên: https://thpt-le-quy-don-giao-vien.twinmonk2.chatgpt.site/

Giáo viên mở địa chỉ website riêng do nhà trường cung cấp, dùng tài khoản riêng và chỉ được xem lịch dạy, lớp được phân công/chủ nhiệm, danh sách học sinh và hồ sơ của mình. Hai website kết nối cùng dự án Supabase để dùng dữ liệu đã đồng bộ của nhà trường; không tạo dữ liệu mẫu riêng cho giáo viên và không cấp quyền sửa trang quản lý. Quyền được lọc ở máy chủ; số CCCD học sinh không được gửi sang website giáo viên.

Thiết lập một lần:

1. Chạy [SQL phân quyền giáo viên](supabase/teacher-portal.sql) sau `sync.sql` trong Supabase SQL Editor. Có thể vào **Giáo viên bộ môn → Tài khoản giáo viên → Sao chép SQL cài đặt** để sao chép trực tiếp.
2. Tạo từng tài khoản email/mật khẩu, có xác nhận email, trong Supabase → Authentication → Users. Không dùng tài khoản quản lý làm tài khoản giáo viên.
3. Trong trang quản lý, cập nhật hồ sơ và phân công giáo viên, chờ **Đã đồng bộ**, rồi vào **Tài khoản giáo viên**. Chọn đúng hồ sơ, nhập email đăng nhập và bấm **Liên kết tài khoản**.
4. Giáo viên mở trang riêng và đăng nhập. Nếu được cấp quyền ở nhiều trường, giáo viên có thể chọn trường. Năm học và danh sách lớp theo dữ liệu được nhà trường phân công.

**Thu hồi quyền** ngừng quyền đọc ở lần yêu cầu tiếp theo. Hồ sơ nghỉ hưu/chuyển công tác hoặc bị xóa cũng không còn quyền xem. Khi đổi email đăng nhập hoặc tên hồ sơ, quản lý cần cập nhật liên kết; thay email liên hệ trong hồ sơ không tự thay quyền. Trang giáo viên lưu phiên đăng nhập riêng với trang quản lý, nên có thể sử dụng hai tài khoản trong cùng trình duyệt. Dữ liệu lớp/học sinh chỉ giữ trong bộ nhớ trang và được xóa khi khóa/đăng xuất.

Mã nguồn triển khai độc lập nằm trong `teacher-site/`. Xuất bản nội dung thư mục này làm gốc của website giáo viên; chỉ gồm giao diện giáo viên, thư viện đăng nhập và cấu hình Supabase công khai, không kèm các chức năng quản lý. `_config.yml` loại thư mục nguồn này khỏi website quản lý trên GitHub Pages. Khi thay đổi `auth.js` hoặc Project URL/Publishable key, cập nhật bản tương ứng trong `teacher-site/` rồi xuất bản lại website giáo viên. Không cần sao chép dữ liệu giữa hai website hoặc chạy lại SQL khi đổi địa chỉ hosting.

## Tính năng

- Thêm, sửa, xóa lớp; kiểm tra sĩ số từ 0 đến 60 học sinh.
- Lưu giáo viên chủ nhiệm và phòng học cho từng lớp.
- Mở “Xem học sinh” trong từng lớp để xem, thêm, sửa và xóa hồ sơ. Sáu lớp mẫu có danh sách học sinh mẫu theo sĩ số, được gắn nhãn **Mẫu**, ngày sinh giả lập và để trống CCCD.
- Phân công, cập nhật, xóa giáo viên bộ môn theo lớp.
- Khi phân công, chọn môn học trước; danh sách lớp chỉ hiển thị các lớp chưa có giáo viên môn đó. Mỗi lớp có một phân công cho mỗi môn; sửa hoặc xóa phân công cũ khi thay giáo viên.
- Xếp, sửa, xóa tiết học theo lớp, thứ và tiết; chặn trùng khung giờ.
- Vinh danh học sinh theo kỳ thi, môn học, điểm và danh hiệu.
- Tự lên lớp theo khóa tuyển sinh: lớp 10 → 11 → 12, tốt nghiệp từ năm học thứ tư.
- Bấm ảnh đại diện hoặc tên trường để thay đổi; thông tin được đồng bộ trên các thiết bị cùng tài khoản.
- Lưu dữ liệu có phân quyền trong Supabase, kèm bộ nhớ đệm và bản chờ trên trình duyệt.

Các lớp mẫu cũ chưa có hồ sơ sẽ được bổ sung một lần; lớp đã có hồ sơ được giữ nguyên. Xóa hồ sơ mẫu sẽ không tự tạo lại khi tải trang. Với lớp tự tạo còn trống, có thể chọn **Tạo học sinh mẫu** để thử. Những hồ sơ này không phải thông tin học sinh thật.

## Theo dõi khóa học qua các năm

Tạo năm học ở nút **Năm học** và giữ chọn **Sao chép từ năm học đang xem** để chuyển tiếp các khóa. Khối và tên lớp tự cập nhật theo năm đích, kể cả khi tạo năm học cách quãng. Thêm lớp 10 và nhập sĩ số để ghi nhận tuyển sinh mới; quy mô theo khối và tổng học sinh chỉ cộng các lớp còn học.

Ví dụ, khóa vào lớp 10 năm 2026 học khối 11 năm 2027, khối 12 năm 2028 và vẫn được tính trong năm học 2028–2029. Từ năm học 2029–2030, khóa được ghi **Đã tốt nghiệp** và không tính vào quy mô đang học. Lớp và hồ sơ học sinh tốt nghiệp vẫn được giữ trong danh sách để tra cứu; dữ liệu từng năm học được lưu riêng.

Lớp đã có được gắn cố định với khóa tuyển sinh; khối tự thay đổi khi chuyển năm học. Với dữ liệu cũ chưa có thông tin khóa, hệ thống suy ra từ khối và năm học đầu tiên lưu lớp đó. Thời khóa biểu và thành tích không sao chép sang năm mới; phân công chỉ chuyển tiếp cho lớp còn học.

## Kiểm tra luồng lên lớp

Cần Node.js, gói `playwright` và Chromium. Chạy `node tests/cohort-lifecycle.cjs`; đặt `CHROMIUM_PATH` nếu Chromium không ở `/usr/bin/chromium`. Kiểm thử dùng dữ liệu giả trong trình duyệt riêng, không thay đổi dữ liệu đang sử dụng. Đặt `COHORT_TEST_ARTIFACT_DIR` để lưu ảnh kiểm tra.

Chạy `node tests/school-avatar.cjs` để kiểm tra chọn ảnh, lưu ảnh đại diện, tải lại và xử lý tệp không hợp lệ. Ảnh được chuẩn hóa trên thiết bị rồi đồng bộ theo tài khoản.

Chạy `node tests/shared-login.cjs` để kiểm tra đăng nhập, khôi phục phiên, đăng xuất và lỗi dịch vụ. Kiểm thử dùng SDK Supabase thật với các phản hồi xác thực giả lập; không cần tài khoản thật. Bộ kiểm thử tải SDK ghim phiên bản vào bộ nhớ đệm ở lần chạy đầu tiên, hoặc nhận đường dẫn SDK qua `SUPABASE_TEST_SDK_PATH`.

Chạy `node tests/sample-students.cjs` để kiểm tra danh sách học sinh mẫu, chuyển đổi dữ liệu cũ, giữ hồ sơ đã nhập, xóa/tải lại và chuyển khóa qua các năm học.

Chạy `node tests/cloud-sync.cjs` để kiểm tra hai phiên trình duyệt riêng, toàn bộ loại hồ sơ, lịch sử năm học, tên/ảnh, dữ liệu cũ, chờ mạng, sửa cùng lúc và tách dữ liệu giữa các tài khoản. Kiểm thử dùng dữ liệu giả, SDK thật và API giả lập; không đọc dữ liệu tài khoản đang dùng.

Chạy `node tests/teacher-portal.cjs` để kiểm tra đăng nhập giáo viên, lịch/lớp/học sinh theo phân công, chuyển năm học, quyền truy cập và cấp/thu hồi liên kết trong trang quản lý.

## Lưu ý về dữ liệu

Các hồ sơ mẫu được đánh dấu rõ để dùng thử. Dữ liệu được đồng bộ theo tài khoản Supabase đã đăng nhập; bản sao và thay đổi chờ vẫn nằm trên thiết bị. Không sử dụng thiết bị chung không đáng tin cậy để lưu thông tin học sinh thật.

Có thể cấu hình GitHub Pages trong **Settings → Pages** để phục vụ website tĩnh từ nhánh `main`, thư mục gốc.
