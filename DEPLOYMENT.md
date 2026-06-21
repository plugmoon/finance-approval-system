# GitHub + Render 部署說明

本系統是 Node.js 後端應用，不適合只放在 GitHub Pages。建議流程是：

1. GitHub 保存程式碼
2. Render 從 GitHub 自動部署 Node Web Service
3. Render 環境變數保存密碼與 LINE token
4. Render persistent disk 保存申請資料與發票附件

## 重要安全提醒

LINE Channel access token 已經是正式憑證，請不要提交到 GitHub。

若 token 曾經貼到公開或半公開地方，建議到 LINE Developers 重新產生一組 token，部署時只填到 Render 的環境變數。

## 推到 GitHub

在 `finance-approval-system` 目錄初始化 Git repo 並推送到 GitHub：

```bash
git init
git add .
git commit -m "Initial finance approval system"
git branch -M main
git remote add origin https://github.com/<你的帳號>/<你的repo>.git
git push -u origin main
```

不要提交以下檔案：

- `.env`
- `data/store.json`
- `data/invoices/`
- `node_modules/`

這些已經寫入 `.gitignore`。

## 在 Render 建立服務

1. 登入 Render
2. 選 New > Blueprint
3. 連接 GitHub repository
4. 選本專案根目錄的 `render.yaml`
5. Render 會建立 `finance-approval-system` Web Service

`render.yaml` 已設定：

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Region: Singapore
- DATA_DIR: `/var/data`
- Persistent disk: `/var/data`

## Render 必填環境變數

Render 建立服務時，請填入：

```text
ADMIN_PASSWORD=請設定正式管理員密碼
APP_BASE_URL=https://你的-render-service.onrender.com
LINE_CHANNEL_ACCESS_TOKEN=你的 LINE Messaging API token
LINE_TARGET_ID=C69edfafe3338ef979e27a2e87abf6dfd
```

`SESSION_SECRET` 會由 Render 自動產生，不需要手動填。

## LINE 設定

目前已取得 LINE 群組 ID：

```text
C69edfafe3338ef979e27a2e87abf6dfd
```

部署完成後，`APP_BASE_URL` 要使用 Render 給你的正式網址，例如：

```text
https://finance-approval-system.onrender.com
```

不要使用 Google Apps Script webhook URL，也不要使用 `localhost:3100`。

## 測試部署

部署完成後依序測試：

1. 開啟 `https://你的-render-service.onrender.com/`
2. 送出一筆費用申請
3. 確認 LINE 群組收到審核訊息
4. 點「同意」
5. 到 `https://你的-render-service.onrender.com/admin` 登入後台
6. 確認申請狀態變成「已同意」

## 資料保存

Render 預設檔案系統是暫存的，重新部署後會遺失寫入資料。本專案使用 persistent disk 掛載在：

```text
/var/data
```

並透過：

```text
DATA_DIR=/var/data
```

讓系統把 `store.json` 與 `invoices/` 存到持久磁碟。

若改用免費方案且不掛 persistent disk，申請資料與發票附件可能在重啟或重新部署後遺失。
