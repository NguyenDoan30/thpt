# Trang giáo viên

Chạy toàn bộ `teacher-portal.sql` trong Supabase → SQL Editor → New query → Run,
sau khi đã chạy `sync.sql`. Tệp có thể chạy lại; dữ liệu trường học đang lưu
không bị thay thế.

1. Trong Supabase → Authentication → Users, tạo một tài khoản riêng cho giáo viên
   bằng email và mật khẩu. Xác nhận email khi tạo tài khoản. Đăng ký công khai
   có thể tiếp tục tắt.
2. Đăng nhập trang quản lý, chờ trạng thái **Đã đồng bộ**, rồi liên kết email
   tài khoản vừa tạo với đúng hồ sơ giáo viên trong phần quản lý quyền truy cập.
3. Giáo viên mở website giáo viên có địa chỉ riêng do nhà trường cung cấp và
   đăng nhập bằng tài khoản riêng đó. Nếu có quyền ở nhiều trường, giáo viên
   chọn trường muốn xem. Liên kết `teacher.html` cũ chỉ chuyển tới địa chỉ mới.

Không dùng tài khoản quản lý làm tài khoản giáo viên. Không gửi mật khẩu hoặc
khóa bí mật qua trò chuyện hay đưa vào mã website.

Hai website dùng chung dự án Supabase và các hàm bên dưới, dù được hosting ở
hai địa chỉ độc lập. Không cần sao chép dữ liệu hoặc chạy lại SQL khi tách
website. Website quản lý cấp/thu hồi liên kết; website giáo viên gọi các hàm
đọc dữ liệu và lưu sổ điểm, bài tập theo quyền. Mã triển khai giáo viên nằm trong `teacher-site/`,
địa chỉ công khai mới được khai báo trong `portal-config.js` của website quản lý.

Website quản lý: https://nguyendoan30.github.io/thpt/

Website giáo viên: https://thpt-le-quy-don-giao-vien.twinmonk2.chatgpt.site/

## Phạm vi dữ liệu

Giáo viên chỉ được xem lớp đang được phân công hoặc chủ nhiệm, lịch dạy của mình
và danh sách học sinh của các lớp đó theo năm học đã chọn. Danh sách học sinh
không trả về CCCD. Thay đổi hồ sơ trường từ trang quản lý được tải lại từ dữ
liệu đã đồng bộ. Điểm và bài tập do giáo viên nhập được lưu riêng, không sửa
bản dữ liệu trường học.

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


## Sổ điểm giáo viên

Sau khi cập nhật mã trang giáo viên, chạy lại toàn bộ `supabase/teacher-portal.sql`
trong Supabase → SQL Editor để tạo bảng và hai hàm sổ điểm. Script có thể chạy
lại an toàn; bảng điểm được lưu riêng theo giáo viên, lớp, môn học và năm học,
không bị xóa khi dữ liệu hồ sơ trường được đồng bộ.

Trong danh sách học sinh, giáo viên chọn học phần, tạo hoặc chọn bài đánh giá,
nhập điểm 0–10 (tối đa một chữ số thập phân), rồi bấm **Lưu điểm**. Máy chủ chỉ
cho phép lưu nếu giáo viên đang được phân công đúng môn và lớp; mã học sinh phải
thuộc lớp đó. Giáo viên không thể đọc/ghi trực tiếp bảng điểm.

- `list_teacher_gradebooks(p_owner_id, p_year, p_class_id, p_subject)` liệt kê
  bài đánh giá của chính giáo viên đang đăng nhập.
- `save_teacher_gradebook(p_owner_id, p_year, p_class_id, p_subject, p_assessment_id, p_title, p_scores)`
  lưu điểm cho danh sách học sinh hiện tại của lớp đã được phân công.

Chế độ demo chỉ lưu điểm trong trình duyệt hiện tại; dữ liệu demo không gửi lên
Supabase và không đại diện cho hồ sơ học sinh thật.

## Giao bài tập

Sau `sync.sql` và `teacher-portal.sql`, chạy toàn bộ
`supabase/teacher-homework.sql` trong Supabase → SQL Editor → New query → Run.
Script có thể chạy lại và không thay thế dữ liệu trường, điểm hoặc bài tập đã
lưu. Cập nhật mã website không tự tạo bảng hoặc hàm trên Supabase; tài khoản
thật cần hoàn tất bước SQL này để lưu và tải bài tập.

Giáo viên mở **Giao bài tập**, chọn lớp và môn đang được phân công, nhập tên bài,
nội dung và hạn nộp. Có thể thêm liên kết tài liệu HTTP/HTTPS. Danh sách hiển
thị bài tập của chính giáo viên trong trường và năm học đang chọn. Khi chỉnh
sửa, thời gian tạo ban đầu được giữ nguyên; mỗi bài có mã UUID riêng để gửi
lại yêu cầu lưu mà không tạo bản sao. Phần sao chép tạo nội dung để giáo viên
gửi cho học sinh; tính năng này chưa có tài khoản học sinh hoặc thông báo tự động.

- `list_teacher_homework(p_owner_id, p_year)` trả về danh sách bài tập thuộc
  tài khoản giáo viên, giới hạn ở các lớp và môn còn được phân công.
- `save_teacher_homework(p_owner_id, p_year, p_class_id, p_subject, p_homework_id, p_title, p_instructions, p_due_date, p_resource_url)`
  tạo hoặc cập nhật bài tập. `p_homework_id` là UUID do trình duyệt tạo để hỗ
  trợ gửi lại yêu cầu; có thể truyền `null` để máy chủ tạo UUID. Tên bài bắt
  buộc, tối đa 150 ký tự; nội dung bắt buộc, tối đa 10.000 ký tự; hạn nộp bắt
  buộc là ngày hợp lệ theo `YYYY-MM-DD`; liên kết không bắt buộc, tối đa 2.000
  ký tự và chỉ nhận HTTP/HTTPS.
- Mỗi bản ghi trả về `id`, `classId`, `subject`, `title`, `instructions`,
  `dueDate`, `resourceUrl`, `createdAt`, `updatedAt`.

Bảng `school_teacher_homework` bật RLS và không cấp quyền đọc/ghi trực tiếp
cho trình duyệt. Hai RPC chỉ cho tài khoản đã xác thực gọi, dùng quyền giáo
viên hiện tại từ `get_teacher_portal` ở mỗi yêu cầu. Chỉ giáo viên được nhà
trường liên kết, còn đang giảng dạy và được phân công đúng lớp/môn mới được
lưu. Tài khoản quản lý không tự nhận quyền giáo viên. Bài tập của giáo viên
khác không thể bị cập nhật, kể cả khi biết UUID; bài của lớp/môn đã bị thu hồi
phân công cũng không thể xem hoặc chỉnh sửa. Dữ liệu cũ vẫn được giữ riêng
khi đồng bộ hồ sơ trường hoặc chuyển năm học.

Chế độ demo chỉ lưu bài tập trong trình duyệt hiện tại và không gọi Supabase.
