# Thiết lập đồng bộ Supabase

Website tĩnh dùng Supabase Auth và một bản dữ liệu riêng cho **mỗi tài khoản**. Hai thiết bị đăng nhập cùng tài khoản sẽ dùng chung các năm học, lớp, hồ sơ học sinh, giáo viên, phân công, thời khóa biểu, thành tích, môn học, tên trường và ảnh đại diện. Các tài khoản khác nhau không đọc hoặc sửa dữ liệu của nhau.

## Chủ dự án thực hiện một lần

1. Mở [SQL Editor của dự án `czqtetrzpdxgcocvaaau`](https://supabase.com/dashboard/project/czqtetrzpdxgcocvaaau/sql/new) bằng tài khoản chủ dự án Supabase.
2. Chọn **New query**, sao chép **toàn bộ** nội dung [sync.sql](./sync.sql) vào trình soạn thảo. Chạy với role **postgres** bằng nút **Run**. Chờ thông báo chạy thành công; nếu có lỗi, giữ nguyên thông báo lỗi để kiểm tra trước khi tiếp tục.
3. Trong **Table Editor**, kiểm tra có bảng `public.school_workspaces` và RLS đã bật. Bảng có thể trống cho đến lần lưu đầu tiên từ website; không cần tự thêm dòng hoặc sửa quyền.
4. Giữ **Authentication → Sign In / Providers → Allow new users to sign up** ở trạng thái tắt. Tạo và quản lý tài khoản được cấp phép tại **Authentication → Users**. Site URL vẫn là `https://nguyendoan30.github.io/thpt/`.
5. Triển khai các tệp website cùng nhau, bao gồm `index.html`, `auth-config.js`, `auth.js`, `cloud-sync.js` và `workspace-sync.js`, rồi tải lại website trên các thiết bị.

SQL có thể chạy lại: không xóa hoặc đặt lại dữ liệu đã lưu. Không cần bật Realtime, tạo Storage bucket hay dùng khóa bí mật. Chỉ chủ dự án cần quyền SQL Editor cho bước thiết lập này; website tiếp tục dùng **Publishable key** công khai trong `auth-config.js`. Không đưa `service_role`, khóa `sb_secret_…`, mật khẩu cơ sở dữ liệu hoặc token quản trị vào website hay chat.

## Dữ liệu và quyền truy cập

Mỗi dòng trong `public.school_workspaces` thuộc về `user_id` là ID Supabase Auth. RLS chỉ cho tài khoản đã xác thực đọc dòng của chính mình. Khách chưa đăng nhập không được đọc hoặc ghi. Trình duyệt không được INSERT, UPDATE hoặc DELETE trực tiếp; mọi lần ghi đi qua hàm `save_school_workspace` do máy chủ kiểm tra ID từ phiên đăng nhập.

`payload` giữ nguyên toàn bộ ảnh chụp dữ liệu của website, gồm các trường bổ sung bên trong dữ liệu cũ. Giới hạn là 8 MiB cho JSON dạng văn bản; ảnh đại diện phải là PNG data URI không quá 1 MiB. Trình duyệt chuyển ảnh được chọn thành PNG kích thước 256 × 256 trước khi lưu. Tên trường dài từ 1 đến 100 ký tự.

```json
{
  "version": 1,
  "current": "2026-2027",
  "years": {},
  "teachers": [],
  "school": { "name": "THPT Lê Quý Đôn", "avatar": null }
}
```

Mỗi lần ghi thành công tăng `revision`. Hàm chỉ lưu khi `p_expected_revision` khớp với bản đang có; giá trị `0` chỉ được tạo dòng đầu tiên. Nếu hai thiết bị cùng sửa một bản, lần ghi sau nhận lỗi `sync_conflict` thay vì âm thầm ghi đè dữ liệu mới hơn. Đăng xuất không xóa dữ liệu trên Supabase. Xóa tài khoản trong Supabase Auth sẽ xóa dòng dữ liệu của tài khoản đó theo khóa ngoại `ON DELETE CASCADE`.

## Hợp đồng API

- Đọc dữ liệu: `supabase.from('school_workspaces').select('user_id,payload,revision,updated_at')` với phiên đăng nhập hiện tại. RLS giới hạn kết quả theo tài khoản.
- Kiểm tra có bản mới: chỉ đọc `revision,updated_at`; không cần tải lại ảnh và toàn bộ hồ sơ ở mỗi lần kiểm tra.
- Ghi dữ liệu: `supabase.rpc('save_school_workspace', {p_expected_revision: revision, p_payload: snapshot})`. Kết quả là mảng có đúng một dòng gồm `user_id`, `payload`, `revision`, `updated_at`.
- Xung đột: SQLSTATE `P0001`, message `sync_conflict`. Phải đọc và xử lý bản máy chủ trước khi thử lưu lại; không tự động đổi số phiên bản để ghi đè.
- Dữ liệu không hợp lệ: SQLSTATE `22023`, message `invalid_workspace_payload`, `invalid_school_avatar` hoặc `invalid_expected_revision`.

## Kiểm tra sau thiết lập

Đăng nhập cùng một tài khoản trên hai trình duyệt hoặc thiết bị. Thêm một lớp thử, sửa tên trường và chọn ảnh đại diện trên thiết bị thứ nhất; kiểm tra thiết bị thứ hai nhận các thay đổi sau khi đồng bộ. Thử sửa đồng thời để kiểm tra thông báo xung đột. Đăng nhập bằng tài khoản được cấp khác để kiểm tra dữ liệu được tách riêng.

Nếu website báo chưa thiết lập đồng bộ, kiểm tra SQL đã chạy trong đúng dự án nêu trên và các tệp website đã được triển khai đầy đủ. Nếu API báo không có bảng hoặc hàm dù SQL vừa thành công, tải lại trang sau vài giây để bộ nhớ đệm schema cập nhật. Không sửa lỗi quyền bằng cách tắt RLS hoặc cấp quyền ghi trực tiếp.
