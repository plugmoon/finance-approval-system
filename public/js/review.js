(function () {
  const params = new URLSearchParams(window.location.search);
  const requestId = params.get('id');
  const token = params.get('token');
  const decision = params.get('decision');
  const elements = {};
  let currentRequest = null;
  let autoApproveStarted = false;

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char]));
  }

  function formatMoney(value) {
    return new Intl.NumberFormat('zh-TW', {
      style: 'currency',
      currency: 'TWD',
      maximumFractionDigits: 0
    }).format(Number(value) || 0);
  }

  function appPath(path) {
    const base = window.APP_BASE_PATH || '';
    return String(path).startsWith('/') ? `${base}${path}` : path;
  }

  async function api(path, options = {}) {
    const response = await fetch(appPath(path), {
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '系統發生錯誤');
    return data;
  }

  function setState(text) {
    elements.reviewState.textContent = text;
  }

  function setMessage(text, type) {
    elements.reviewMessage.textContent = text;
    elements.reviewMessage.className = `form-message ${type || ''}`;
  }

  function statusBadge(request) {
    return `<span class="status-badge ${request.status}">${escapeHtml(request.status_label)}</span>`;
  }

  function renderDetail(request) {
    currentRequest = request;
    elements.reviewDetail.innerHTML = `
      <dt>申請單號</dt><dd>${escapeHtml(request.request_no)}</dd>
      <dt>狀態</dt><dd>${statusBadge(request)}</dd>
      <dt>申請人</dt><dd>${escapeHtml(request.employee_name)}</dd>
      <dt>單位</dt><dd>${escapeHtml(request.unit_name || '未設定')}</dd>
      <dt>部門</dt><dd>${escapeHtml(request.department || '未設定')}</dd>
      <dt>費用類別</dt><dd>${escapeHtml(request.category)}</dd>
      <dt>申請項目</dt><dd>${escapeHtml(request.expense_item)}</dd>
      <dt>申請金額</dt><dd>${escapeHtml(formatMoney(request.amount))}</dd>
      <dt>發生日期</dt><dd>${escapeHtml(request.occurred_on)}</dd>
      <dt>內容描述</dt><dd>${escapeHtml(request.description)}</dd>
      <dt>備註</dt><dd>${escapeHtml(request.note || '無')}</dd>
      <dt>發票</dt><dd>${request.invoice ? `<a href="${escapeHtml(request.invoice.url)}" target="_blank" rel="noopener">查看發票：${escapeHtml(request.invoice.original_name || request.invoice.filename)}</a>` : '未上傳'}</dd>
      <dt>不同意理由</dt><dd>${escapeHtml(request.rejection_reason || '無')}</dd>
    `;

    const isPending = request.status === 'pending';
    elements.reviewActions.hidden = !isPending || decision === 'approve';
    elements.rejectForm.hidden = !(isPending && decision === 'reject');
    setState(request.status_label);
  }

  async function loadReview() {
    if (!requestId || !token) {
      setState('連結無效');
      setMessage('缺少審核資訊，請回到 Email 通知重新點選審核連結。', 'error');
      return;
    }

    try {
      const data = await api(`/api/reviews/${encodeURIComponent(requestId)}?token=${encodeURIComponent(token)}`);
      renderDetail(data.request);
      if (decision === 'approve' && data.request.status === 'pending' && !autoApproveStarted) {
        autoApproveStarted = true;
        await approveRequest();
      }
    } catch (error) {
      setState('讀取失敗');
      setMessage(error.message, 'error');
    }
  }

  async function approveRequest() {
    setMessage('正在送出同意結果...', '');
    elements.reviewActions.hidden = true;
    try {
      const data = await api(`/api/reviews/${encodeURIComponent(requestId)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ token })
      });
      renderDetail(data.request);
      setMessage('已同意，此筆資料已進入後台財務紀錄。', 'success');
    } catch (error) {
      setMessage(error.message, 'error');
      elements.reviewActions.hidden = !currentRequest || currentRequest.status !== 'pending';
    }
  }

  async function rejectRequest(event) {
    event.preventDefault();
    const formData = new FormData(elements.rejectForm);
    const reason = String(formData.get('reason') || '').trim();
    setMessage('正在送出不同意理由...', '');
    try {
      const data = await api(`/api/reviews/${encodeURIComponent(requestId)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ token, reason })
      });
      renderDetail(data.request);
      elements.rejectForm.hidden = true;
      setMessage('已送出不同意理由，申請者可依理由修正。', 'success');
    } catch (error) {
      setMessage(error.message, 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    [
      'reviewState',
      'reviewDetail',
      'reviewActions',
      'approveButton',
      'showRejectButton',
      'rejectForm',
      'cancelRejectButton',
      'reviewMessage'
    ].forEach((id) => {
      elements[id] = byId(id);
    });

    elements.approveButton.addEventListener('click', approveRequest);
    elements.showRejectButton.addEventListener('click', () => {
      elements.rejectForm.hidden = false;
      elements.reviewActions.hidden = true;
    });
    elements.cancelRejectButton.addEventListener('click', () => {
      elements.rejectForm.hidden = true;
      elements.reviewActions.hidden = false;
      setMessage('', '');
    });
    elements.rejectForm.addEventListener('submit', rejectRequest);
    loadReview();
  });
}());
