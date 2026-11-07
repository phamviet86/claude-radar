# Thread Board

Bảng Kanban **chỉ đọc** cho các thread Claude Code trong **Claude desktop**: thread nào cần bạn, thread nào đang chạy, thread nào đã xong, và mỗi dự án (thư mục) đang làm gì.

Không có phụ thuộc nào, không cài plugin hay hook vào Claude, không ghi gì vào `~/.claude` hay dữ liệu của app. Muốn trả lời một thread, bạn vẫn mở nó trong Claude desktop.

## Chạy

```bash
npm start        # http://127.0.0.1:4848  (đổi cổng: PORT=5000 npm start)
npm test
```

Cần Node 22 trở lên. Máy chủ chỉ nghe ở `127.0.0.1` và từ chối Host khác, nên tiêu đề và tóm tắt thread không rời khỏi máy.

## Giao diện

- **Thẻ gọn:** chỉ có tên thread, các thread con kèm trạng thái, nhãn dự án và thời gian. Bấm vào thẻ để mở **timeline** (xem bên dưới).
- **Nhãn dự án:** mỗi thư mục có một biểu tượng riêng kèm màu, cố định theo tên và không trùng nhau giữa các thư mục đang có (đổi khi thêm hoặc bớt thư mục).
- **Bảng:** ba cột Cần input, Đang thực hiện, Hoàn thành. Thread con nằm trong thẻ của thread cha; trạng thái của thẻ là trạng thái tệ nhất của cả nhóm (cần input > đang làm > xong), nên cha chỉ "xong" khi mọi thread con cũng xong.
- **Cột Hoàn thành:** chia theo ngày (Hôm nay, Hôm qua, Tuần này, Cũ hơn), mỗi nhóm thu gọn được; "Cũ hơn" thu gọn sẵn. Thread có thread con hiện thêm nhãn "★ N thread con".
- **Tìm theo tên thread**, **ghim** (thread đánh dấu sao trong Claude desktop nằm đầu cột), lọc theo thư mục, và chia dòng theo thư mục.
- **Tab Dự án:** mỗi thư mục có số thread theo trạng thái, đang làm gì, đã làm được gì và cây thread.
- Tự làm mới mỗi 5 giây. Thread đã lưu trữ trong Claude desktop bị ẩn.

## Timeline

Bấm vào một thẻ (hoặc một thread con) để mở ngăn chi tiết. Nhóm có nhiều thread thì chọn thread cần xem ở phía trên. Timeline liệt kê, mới nhất trước: mỗi lượt gồm lời bạn nhắn, các công cụ đã dùng (chỉ tên và số lần), câu trả lời cuối của Claude và thời gian chạy; cùng các mốc "Tạo thread" và "Thread con được tạo". Hiển thị tối đa 60 lượt gần nhất.

Timeline là phần duy nhất đọc **nội dung hội thoại** (`~/.claude/projects/*/<id>.jsonl`), và chỉ khi bạn mở thread. Văn bản được cắt ngắn; suy nghĩ của Claude, nội dung và kết quả công cụ không bao giờ được giữ lại hay gửi đi. Máy chủ chỉ nghe ở `127.0.0.1`.

## Dữ liệu và cách suy ra trạng thái

| Nguồn | Dùng để |
| --- | --- |
| `~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json` | Mọi thread: tiêu đề, thư mục, thread mẹ (`spawnedFrom`), ghim (`isStarred`), lưu trữ, tóm tắt cuối lượt (`postTurnSummary`) |
| `~/.claude/sessions/<pid>.json` | Thread đang chạy: `status` là `busy`, `idle`, `waiting` hoặc `shell` |
| `~/.claude/projects/*/<cliSessionId>.jsonl` | Chỉ cho timeline, khi bạn mở một thread |

Thứ tự ưu tiên, theo `threadStatus` trong `lib/model.js`:

1. Tiến trình `waiting` (chờ cấp quyền...) → **Cần input**; `busy` hoặc `shell` → **Đang thực hiện** (tóm tắt lúc đó là của lượt trước, nên được gắn nhãn "LƯỢT TRƯỚC").
2. Tóm tắt cuối lượt: `blocked` hoặc `review_ready` → **Cần input**; `completed` → **Hoàn thành**.
3. Không có tóm tắt: tiến trình còn sống → **Đang thực hiện**; đã tắt → **Hoàn thành**, ghi "Chưa có tóm tắt".

Thread nối với tiến trình bằng `hostSessionId` (rồi `sessionId` của CLI). Thread con có mẹ đã lưu trữ hoặc không còn thì đứng riêng. Thư mục của dự án là `originCwd` (worktree gộp về dự án chính).

## Giới hạn đã biết

- "Cần input" và "Hoàn thành" dựa trên tóm tắt Claude tự viết sau mỗi lượt nên đôi khi sai; trang luôn nói rõ điều này.
- Đây là định dạng nội bộ của Claude, có thể đổi giữa các phiên bản. Khi không đọc được, trang hiện cảnh báo thay vì lỗi.
- Chỉ thấy thread trên máy này (không thấy phiên SSH hay đám mây). Chưa hỗ trợ nhiều cấu hình Claude (`CLAUDE_CONFIG_DIR` chỉ nhận một thư mục).
- Thread đang bận hiện tóm tắt của lượt trước, không phải việc đang làm lúc này (Claude không công bố việc đang làm hiện tại ở hai nguồn trên).

## Biến môi trường

| Biến | Tác dụng |
| --- | --- |
| `PORT` | Cổng (mặc định 4848) |
| `THREAD_BOARD_DESKTOP` | Thư mục thread của Claude desktop; `off` để tắt |
| `CLAUDE_CONFIG_DIR` | Thư mục cấu hình Claude Code (mặc định `~/.claude`) |
