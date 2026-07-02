# Oracle Cloud Always Free VM 部署指南

本文件適用於目前這套 `finance-approval-system`，部署方式為：

- Oracle Cloud Always Free VM
- Ubuntu Linux
- Node.js 22
- systemd 常駐服務
- Nginx 反向代理
- 可選 HTTPS 憑證

> 重要：不要把 `.env`、LINE token、管理員密碼、`data/store.json`、`data/invoices/` 上傳到 GitHub。

## 1. Oracle Cloud 帳號與免費額度注意事項

1. 到 Oracle Cloud Free Tier 註冊帳號。
2. 註冊會要求信用卡驗證；Oracle 文件說明 Free Tier 不升級成付費帳號時，不會因 Free Trial 結束而中斷 Always Free 資源。
3. 建議 Home Region 選離台灣近、容量較好的區域，例如 Japan East / Tokyo、Japan Central / Osaka、Singapore 等，但實際可用區域以註冊時畫面為準。
4. Home Region 選定後很難更換，Always Free VM 必須建立在 Home Region。
5. 建立資源時務必確認畫面有 `Always Free eligible` 標示。

建議 VM 規格：

- 優先：`VM.Standard.A1.Flex`
  - OCPU：1 或 2
  - Memory：6GB 或 12GB
  - 適合這套系統，記憶體比較夠。
- 備選：`VM.Standard.E2.1.Micro`
  - 1GB RAM
  - 可以跑，但較容易卡在安裝套件或更新。

如果出現 `Out of host capacity`，代表該區域暫時沒有免費機器容量，可以改其他 Availability Domain、晚點再試，或改用 E2 Micro。

## 2. 建立 VM

1. 登入 Oracle Cloud Console。
2. 左上角選單進入 `Compute` > `Instances`。
3. 點 `Create instance`。
4. Name 填：

```text
finance-approval-system
```

5. Image 選 Ubuntu，建議：

```text
Canonical Ubuntu 24.04
```

若沒有 Ubuntu 24.04，可選 Ubuntu 22.04。

6. Shape 選 Always Free eligible：

```text
VM.Standard.A1.Flex
```

建議先設：

```text
OCPU: 1
Memory: 6 GB
```

7. Networking：

- 可使用 Oracle 自動建立的 VCN。
- 勾選 `Assign a public IPv4 address`。
- 保留 Public subnet。

8. SSH keys：

- 選 `Generate a key pair for me`。
- 下載 `private key`。
- 建議把 key 存到 Windows：

```text
C:\Users\你的帳號\.ssh\oracle_finance.key
```

9. Boot volume：

- 保持預設 50GB 即可。

10. 點 `Create`。

建立完成後，記下 VM 的 Public IPv4，例如：

```text
123.123.123.123
```

## 3. 開啟 Oracle 網路防火牆

Oracle VM 有兩層防火牆：

1. Oracle Cloud VCN / Security List 或 Network Security Group
2. VM 裡面的 Linux 防火牆

先設定 Oracle Cloud VCN：

1. 進入你的 Instance。
2. 點選 `Primary VNIC`。
3. 點 Subnet。
4. 找到 `Security Lists` 或 `Network Security Groups`。
5. 新增 Ingress Rules。

正式環境建議開：

| Source CIDR | Protocol | Destination Port | 用途 |
|---|---|---:|---|
| 你的固定 IP/32 | TCP | 22 | SSH 管理 |
| 0.0.0.0/0 | TCP | 80 | HTTP |
| 0.0.0.0/0 | TCP | 443 | HTTPS |

如果你只是先測試，也可以暫時開：

| Source CIDR | Protocol | Destination Port | 用途 |
|---|---|---:|---|
| 0.0.0.0/0 | TCP | 3100 | 直接測 Node app |

測試完建議關閉 3100，正式只讓 Nginx 對外開 80/443。

## 4. 從 Windows 連線到 VM

開啟 PowerShell。

如果使用 Ubuntu image，帳號通常是：

```text
ubuntu
```

連線：

```powershell
ssh -i C:\Users\你的帳號\.ssh\oracle_finance.key ubuntu@你的_VM_Public_IP
```

範例：

```powershell
ssh -i C:\Users\an089\.ssh\oracle_finance.key ubuntu@123.123.123.123
```

如果出現 private key 權限錯誤，在 PowerShell 執行：

```powershell
icacls C:\Users\你的帳號\.ssh\oracle_finance.key /inheritance:r
icacls C:\Users\你的帳號\.ssh\oracle_finance.key /grant:r "$($env:USERNAME):(R)"
```

再重新 SSH。

## 5. 安裝 Node.js、Git、Nginx

進入 VM 後執行：

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y curl git nginx ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

確認 Node.js 版本為 22.x 或至少 18.x。

## 6. 放置專案程式

建議先把專案放到 GitHub，然後在 VM clone。

```bash
sudo mkdir -p /opt/finance-approval-system
sudo chown -R ubuntu:ubuntu /opt/finance-approval-system
git clone https://github.com/你的GitHub帳號/finance-approval-system.git /opt/finance-approval-system
cd /opt/finance-approval-system
npm install --omit=dev
```

如果你使用 Oracle Linux image，系統帳號可能是 `opc`，上面的 `ubuntu:ubuntu` 要改成：

```bash
sudo chown -R opc:opc /opt/finance-approval-system
```

## 7. 建立資料目錄

正式資料不要放在 GitHub repo 內，建議放在 `/var/lib`。

```bash
sudo mkdir -p /var/lib/finance-approval-system/data
sudo chown -R ubuntu:ubuntu /var/lib/finance-approval-system
```

如果使用 Oracle Linux：

```bash
sudo chown -R opc:opc /var/lib/finance-approval-system
```

## 8. 設定 .env

進入專案目錄：

```bash
cd /opt/finance-approval-system
cp .env.example .env
nano .env
```

建議內容：

```env
PORT=3100
HOST=127.0.0.1
DATA_DIR=/var/lib/finance-approval-system/data
APP_BASE_URL=https://你的網域
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

如果你還沒有網域，先測試時可以暫時使用：

```env
APP_BASE_URL=http://你的_VM_Public_IP
```

但正式 LINE 審核建議使用 HTTPS 網域，例如：

```env
APP_BASE_URL=https://finance.example.com
```

> 你的 LINE token 曾經出現在聊天內容中，正式上線前建議到 LINE Developers 重新發一組新的 Channel access token，再填入 VM 的 `.env`。

## 9. 先手動測試

```bash
cd /opt/finance-approval-system
npm start
```

看到類似伺服器啟動訊息後，先按 `Ctrl + C` 停止。

如果 `HOST=127.0.0.1`，外部無法直接開 `:3100`，這是正常的，後面會用 Nginx 對外提供服務。

## 10. 建立 systemd 常駐服務

建立服務檔：

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
User=ubuntu
WorkingDirectory=/opt/finance-approval-system
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

如果你使用 Oracle Linux，請把：

```ini
User=ubuntu
```

改成：

```ini
User=opc
```

啟動服務：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now finance-approval
sudo systemctl status finance-approval --no-pager
```

查看即時 log：

```bash
sudo journalctl -u finance-approval -f
```

## 11. 設定 Nginx

建立 Nginx 設定：

```bash
sudo nano /etc/nginx/sites-available/finance-approval
```

如果有網域，貼上：

```nginx
server {
    listen 80;
    server_name finance.example.com;

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

把 `finance.example.com` 改成你的正式網域。

如果還沒有網域，只用 IP 測試，貼上：

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

啟用設定：

```bash
sudo ln -s /etc/nginx/sites-available/finance-approval /etc/nginx/sites-enabled/finance-approval
sudo nginx -t
sudo systemctl reload nginx
```

若遇到 default site 衝突，可以移除預設站台：

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## 12. 設定 VM 內部防火牆

Ubuntu 可使用 UFW：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

如果只是測試 3100 port：

```bash
sudo ufw allow 3100/tcp
```

正式用 Nginx 後，建議不要開 3100 對外。

## 13. 設定網域與 HTTPS

如果你有網域：

1. 到網域 DNS 後台。
2. 新增 A record：

```text
Name: finance
Type: A
Value: 你的_VM_Public_IP
```

3. 等 DNS 生效後，測試：

```bash
curl -I http://finance.example.com
```

4. 安裝 HTTPS：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d finance.example.com
```

5. 完成後，把 `.env` 裡的 `APP_BASE_URL` 改成：

```env
APP_BASE_URL=https://finance.example.com
```

6. 重啟服務：

```bash
sudo systemctl restart finance-approval
```

如果你暫時沒有網域，可以先用：

```text
http://你的_VM_Public_IP
```

測試前台與後台，但正式 LINE 審核連結建議改成 HTTPS。

## 14. LINE 設定

目前已知 LINE 群組 ID：

```text
C69edfafe3338ef979e27a2e87abf6dfd
```

VM 上的 `.env` 必須有：

```env
APP_BASE_URL=https://你的正式網址
LINE_CHANNEL_ACCESS_TOKEN=你的_LINE_Channel_Access_Token
LINE_TARGET_ID=C69edfafe3338ef979e27a2e87abf6dfd
```

注意：

- `APP_BASE_URL` 要填 Oracle VM 的正式網址。
- 不要填 Google Apps Script URL。
- 不要填 `localhost:3100`。
- 如果換了網址，改完 `.env` 後要重啟服務。

```bash
sudo systemctl restart finance-approval
```

## 15. 上線測試流程

1. 開啟前台：

```text
https://你的正式網址/
```

2. 填一筆費用申請。
3. 確認 LINE 群組收到審核訊息。
4. 老闆點 `同意`。
5. 開啟後台：

```text
https://你的正式網址/admin
```

6. 登入管理員。
7. 確認財務申請清單出現該筆已核可資料。
8. 再測一筆 `不同意`，確認可填寫不同意理由。
9. 用員工帳號登入後台，確認員工只能看自己的資料與待審核申請。

## 16. 更新系統

之後如果 GitHub 上有新版程式，在 VM 執行：

```bash
cd /opt/finance-approval-system
git pull
npm install --omit=dev
sudo systemctl restart finance-approval
sudo systemctl status finance-approval --no-pager
```

## 17. 備份資料

這套系統正式資料在：

```text
/var/lib/finance-approval-system/data/store.json
/var/lib/finance-approval-system/data/invoices/
```

手動備份：

```bash
tar -czf ~/finance-backup-$(date +%F).tar.gz /var/lib/finance-approval-system/data
```

從 Windows 下載備份：

```powershell
scp -i C:\Users\你的帳號\.ssh\oracle_finance.key ubuntu@你的_VM_Public_IP:~/finance-backup-YYYY-MM-DD.tar.gz .
```

建議至少每週備份一次。

## 18. 常見問題

### 網頁打不開

檢查服務：

```bash
sudo systemctl status finance-approval --no-pager
sudo journalctl -u finance-approval -n 80 --no-pager
```

檢查 Nginx：

```bash
sudo nginx -t
sudo systemctl status nginx --no-pager
```

檢查 Oracle VCN 是否有開 80/443。

### LINE 沒收到訊息

檢查 `.env`：

```bash
cd /opt/finance-approval-system
nano .env
```

確認：

- `LINE_CHANNEL_ACCESS_TOKEN` 是 Messaging API 的 channel access token。
- `LINE_TARGET_ID` 是群組 ID。
- `APP_BASE_URL` 是正式網址。

改完要重啟：

```bash
sudo systemctl restart finance-approval
```

查看 log：

```bash
sudo journalctl -u finance-approval -f
```

### 出現 502 Bad Gateway

通常是 Node app 沒有跑。

```bash
sudo systemctl restart finance-approval
sudo journalctl -u finance-approval -n 80 --no-pager
```

### SSH 連不上

確認：

- VM 是 Running。
- Public IP 正確。
- Oracle Security List 有開 22。
- SSH username 正確：Ubuntu 是 `ubuntu`，Oracle Linux 是 `opc`。
- private key 是建立 VM 時下載的那一把。

## 19. 省錢檢查清單

- VM shape 必須顯示 `Always Free eligible`。
- Boot volume 使用預設 50GB 即可。
- 不要建立付費 Load Balancer。
- 不要建立額外付費資料庫。
- 不要把資料放到會額外收費的服務。
- 定期檢查 Billing / Cost Analysis。
- 設定 Budget Alert。
- 不使用的 VM、Volume、Public IP、Backup 要刪除。

