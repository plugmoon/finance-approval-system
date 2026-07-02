# 凱凱/亞太/鋼鐵人 三合一財務審核系統

這是獨立的財務審核系統專案，包含員工費用申請、Email 審核通知、審核連結、拒絕理由、後台員工權限管理、費用類別、單位與財務申請資料管理。

## 主要功能

- 員工在前台送出費用申請與發票照片。
- 系統建立申請單後，改用 Email 寄送審核通知。
- Email 內含「同意」與「不同意」審核連結。
- 後台管理員可設定通知收件 Email。
- SMTP 主機、帳號、密碼與寄件人由伺服器 `.env` 管理。
- 管理員可新增、編輯、刪除員工、單位、費用類別與財務紀錄。
- 員工登入後可查看自己的申請，且只能修改待審核項目。

## 啟動

```bash
npm start
```

預設網址：

- 前台員工申請：`http://localhost:3100/`
- 後台管理：`http://localhost:3100/admin`

## Email 設定

伺服器 `.env` 需要設定 SMTP：

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-account@gmail.com
SMTP_PASSWORD=your-app-password
SMTP_FROM=your-account@gmail.com
```

通知收件人不用寫在 `.env`，請用管理員登入後台：

1. 進入「設定」。
2. 在「Email 通知設定」輸入收件 Email。
3. 可一行一個，或用逗號分隔。
4. 按下「儲存 Email 通知設定」。

若尚未設定 SMTP 或收件 Email，申請仍會成功儲存，但 Email 通知會顯示為略過。

## 資料位置

申請、員工、單位、類別與通知設定：

```text
data/store.json
```

發票照片：

```text
data/invoices/
```
