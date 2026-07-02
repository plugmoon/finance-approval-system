# Google Cloud e2-micro 部署指南

本文件適用於目前這套 `finance-approval-system`，部署方式為：

- Google Compute Engine `e2-micro`
- Ubuntu Linux
- Node.js 22
- systemd 常駐服務
- Nginx 反向代理
- 可選 HTTPS 憑證

## 1. 費用先看清楚

Google Cloud Free Tier 目前提供：

- 每月 1 台非 Spot / 非 Preemptible 的 `e2-micro` VM
- 區域限定：`us-west1`、`us-central1`、`us-east1`
- 30 GB-month standard persistent disk
- 每月 1 GB 從北美出去的網路流量

注意：

- 不要選台灣、東京、新加坡，這些不是 `e2-micro` 免費區域。
- 磁碟請選 `Standard persistent disk`，容量不要超過 30 GB。
- 不要建立 Load Balancer、Cloud SQL、NAT Gateway、額外磁碟或 snapshot。
- Google 目前會對外部 IPv4 地址計費。若 VM 需要固定公網 IPv4，可能會有小額月費。最省錢做法是先用臨時 IPv4 上線；若要更接近免費，後續可改 Cloudflare Tunnel 或 IPv6 架構。

建議區域：

```text
us-west1
```

這是 Oregon，從台灣連線通常比 `us-central1`、`us-east1` 稍近。

## 2. 建立 Google Cloud 專案

1. 開啟 Google Cloud Console。
2. 建立新專案：

```text
finance-approval-system
```

3. 確認已綁定 Billing account。
4. 建議立刻設定 Budget Alert，例如每月 1 美元或 5 美元。

## 3. 建立 VM

進入：

```text
Compute Engine > VM instances > Create instance
```

基本設定：

```text
Name: finance-approval-system
Region: us-west1
Zone: us-west1-a
Machine type: e2-micro
Provisioning model: Standard
```

不要選：

```text
Spot
Preemptible
```

作業系統建議：

```text
Ubuntu 24.04 LTS
```

Boot disk：

```text
Type: Standard persistent disk
Size: 30 GB
```

Firewall：

勾選：

```text
Allow HTTP traffic
Allow HTTPS traffic
```

Network tags 通常會自動加入：

```text
http-server
https-server
```

先暫時保留 External IPv4，方便瀏覽器 SSH、安裝套件與測試網站。上線穩定後，如果要再壓低費用，可以評估 Cloudflare Tunnel。

建立前請確認估價畫面沒有出現奇怪的服務，例如 Load Balancer、Cloud SQL、GPU、額外磁碟。

## 4. 連線 VM

VM 建好後，在 VM instances 清單按：

```text
SSH
```

Google 會開瀏覽器 SSH 視窗，不需要下載 `.pem` 或 `.key`。

## 5. 安裝 Node.js、Git、Nginx

在 SSH 視窗執行：

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y curl git nginx ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 6. 放置專案程式

建議把專案放到 GitHub 後，在 VM clone：

```bash
sudo mkdir -p /opt/finance-approval-system
sudo chown -R "$USER:$USER" /opt/finance-approval-system
git clone https://github.com/你的GitHub帳號/finance-approval-system.git /opt/finance-approval-system
cd /opt/finance-approval-system
npm install --omit=dev
```

如果還沒有 GitHub repo，也可以先用 Google Cloud SSH 視窗的上傳功能或 `scp` 上傳專案壓縮檔，但 GitHub 會比較好維護。

## 7. 建立資料目錄

正式資料不要放在 Git repo 內：

```bash
sudo mkdir -p /var/lib/finance-approval-system/data
sudo chown -R "$USER:$USER" /var/lib/finance-approval-system
```

系統資料會存：

```text
/var/lib/finance-approval-system/data/store.json
/var/lib/finance-approval-system/data/invoices/
```

## 8. 設定 .env

```bash
cd /opt/finance-approval-system
cp .env.example .env
nano .env
```

內容範例：

```env
PORT=3100
HOST=127.0.0.1
DATA_DIR=/var/lib/finance-approval-system/data
APP_BASE_URL=http://你的_VM_外部_IP
ADMIN_USERNAME=admin
ADMIN_PASSWORD=請改成很強的管理員密碼
SESSION_SECRET=請放一組長隨機字串
LINE_CHANNEL_ACCESS_TOKEN=你的_LINE_Channel_Access_Token
LINE_TARGET_ID=C69edfafe3338ef979e27a2e87abf6dfd
```

產生 `SESSION_SECRET`：

```bash
openssl rand -hex 32
```

正式使用 LINE 審核連結時，建議使用 HTTPS 網域：

```env
APP_BASE_URL=https://finance.example.com
```

> 你的 LINE token 曾經出現在聊天內容中，正式上線前建議到 LINE Developers 重新發一組新的 Channel access token。

## 9. 先手動測試

```bash
cd /opt/finance-approval-system
npm start
```

看到伺服器啟動後，按 `Ctrl + C` 停止。

## 10. 建立 systemd 常駐服務

```bash
sudo nano /etc/systemd/system/finance-approval.service
```

貼上：

```ini
[Unit]
Description=Finance Approval System
After=network.target

[Service]
Type=simple
User=%i
WorkingDirectory=/opt/finance-approval-system
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

因為 systemd 檔案內不能直接使用 shell 的 `$USER`，請執行：

```bash
sudo sed -i "s/User=%i/User=$USER/" /etc/systemd/system/finance-approval.service
sudo systemctl daemon-reload
sudo systemctl enable --now finance-approval
sudo systemctl status finance-approval --no-pager
```

查看 log：

```bash
sudo journalctl -u finance-approval -f
```

## 11. 設定 Nginx

```bash
sudo nano /etc/nginx/sites-available/finance-approval
```

如果暫時用 IP：

```nginx
server {
    listen 80 default_server;
    server_name _;

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

啟用：

```bash
sudo ln -s /etc/nginx/sites-available/finance-approval /etc/nginx/sites-enabled/finance-approval
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

開啟：

```text
http://你的_VM_外部_IP/
```

## 12. 設定網域與 HTTPS

如果你有網域，DNS 新增 A record：

```text
Name: finance
Type: A
Value: 你的_VM_外部_IP
```

安裝 HTTPS：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d finance.example.com
```

改 `.env`：

```env
APP_BASE_URL=https://finance.example.com
```

重啟：

```bash
sudo systemctl restart finance-approval
```

## 13. LINE 測試

1. 開啟前台：

```text
https://你的正式網址/
```

2. 送出一筆費用申請。
3. 確認 LINE 群組收到審核訊息。
4. 點同意。
5. 到後台確認紀錄。

## 14. 更新系統

```bash
cd /opt/finance-approval-system
git pull
npm install --omit=dev
sudo systemctl restart finance-approval
```

## 15. 備份資料

```bash
tar -czf ~/finance-backup-$(date +%F).tar.gz /var/lib/finance-approval-system/data
```

建議每週下載備份一次。

## 16. 省錢檢查清單

- Region 必須是 `us-west1`、`us-central1` 或 `us-east1`。
- Machine type 必須是 `e2-micro`。
- Provisioning model 使用 `Standard`。
- Boot disk 使用 `Standard persistent disk`。
- Boot disk 不超過 30 GB。
- 不建立 Load Balancer。
- 不建立 Cloud SQL。
- 不建立 Cloud NAT。
- 不建立額外磁碟或 snapshot。
- 建立 Budget Alert。
- 注意外部 IPv4 可能會有小額費用。

