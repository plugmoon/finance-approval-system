(function () {
  const state = {
    categories: [],
    employees: [],
    invoiceMode: '',
    unitsById: new Map()
  };

  const elements = {};

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

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function setState(text) {
    elements.loadState.textContent = text;
  }

  function fillSelect(select, rows, placeholder, renderOption) {
    select.innerHTML = `<option value="">${placeholder}</option>${rows.map(renderOption).join('')}`;
  }

  function employeeLabel(employee) {
    const unitText = (employee.unit_names || [employee.unit_name]).filter(Boolean).join('、') || '未設定單位';
    return `${employee.employee_no} ${employee.name}｜${unitText} / ${employee.department || '未設定部門'}`;
  }

  function selectedEmployee() {
    return state.employees.find((item) => Number(item.id) === Number(elements.employeeSelect.value)) || null;
  }

  function employeeUnits(employee) {
    const unitIds = employee ? (employee.unit_ids || [employee.unit_id]) : [];
    return unitIds
      .map((id) => state.unitsById.get(Number(id)))
      .filter(Boolean);
  }

  function renderRequestUnits(employee) {
    const units = employeeUnits(employee);
    if (!units.length) {
      elements.requestUnitSelect.innerHTML = '<option value="">請先選擇員工</option>';
      return;
    }
    elements.requestUnitSelect.innerHTML = units.map((unit, index) => (
      `<option value="${unit.id}"${index === 0 ? ' selected' : ''}>${escapeHtml(unit.name)}</option>`
    )).join('');
  }

  function renderEmployeeContext() {
    const employee = selectedEmployee();
    renderRequestUnits(employee);
    if (!employee) {
      elements.employeeContext.textContent = '請先選擇申請員工，系統會帶入所屬單位與部門。';
      return;
    }
    const units = employeeUnits(employee).map((unit) => unit.name).join('、') || '未設定';
    elements.employeeContext.innerHTML = `
      <strong>${escapeHtml(employee.name)}</strong>
      <span>可用單位：${escapeHtml(units)}</span>
      <span>部門：${escapeHtml(employee.department || '未設定')}</span>
    `;
  }

  function renderBootstrap() {
    fillSelect(elements.employeeSelect, state.employees, '請選擇員工', (employee) => (
      `<option value="${employee.id}">${escapeHtml(employeeLabel(employee))}</option>`
    ));
    fillSelect(elements.categorySelect, state.categories, '請選擇類別', (category) => (
      `<option value="${category.id}">${escapeHtml(category.name)}</option>`
    ));
    elements.occurredOn.value = today();
    renderEmployeeContext();
  }

  function renderInvoiceMode() {
    elements.invoiceCameraPanel.hidden = state.invoiceMode !== 'camera';
    elements.invoiceUploadPanel.hidden = state.invoiceMode !== 'upload';
    elements.invoiceModeButtons.forEach((button) => {
      const active = button.dataset.invoiceMode === state.invoiceMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    renderInvoicePreview();
  }

  function setInvoiceMode(mode) {
    state.invoiceMode = mode;
    elements.invoiceInput.value = '';
    elements.invoiceCameraInput.value = '';
    renderInvoiceMode();
  }

  function selectedInvoiceFile() {
    return elements.invoiceInput.files[0] || elements.invoiceCameraInput.files[0] || null;
  }

  function renderInvoicePreview() {
    const file = selectedInvoiceFile();
    if (!file) {
      if (state.invoiceMode === 'camera') {
        elements.invoicePreview.textContent = '請點選上方欄位開啟相機拍攝發票。';
      } else if (state.invoiceMode === 'upload') {
        elements.invoicePreview.textContent = '請點選上方欄位，從手機相簿選擇發票照片。';
      } else {
        elements.invoicePreview.textContent = '請先選擇拍攝照片或上傳發票。';
      }
      return;
    }
    const sizeKb = Math.round(file.size / 1024);
    elements.invoicePreview.innerHTML = `
      <strong>${escapeHtml(file.name || '發票照片')}</strong>
      <span>${escapeHtml(file.type || 'image')}，約 ${sizeKb} KB</span>
    `;
  }

  function resultHtml(request, delivery = {}) {
    const deliveryText = delivery.status === 'sent'
      ? 'Email 通知已送出'
      : delivery.status === 'skipped'
        ? '申請已儲存，尚未啟用 Email 通知'
        : `申請已儲存，Email 通知失敗：${delivery.message || '未知錯誤'}`;
    const invoiceText = request.invoice ? `發票：${request.invoice.original_name || '已上傳'}` : '發票：未上傳';

    return `
      <div class="result-box">
        <strong>${escapeHtml(request.request_no)}</strong>
        <span>申請人：${escapeHtml(request.employee_name)}</span>
        <span>單位：${escapeHtml(request.unit_name || '未設定')}</span>
        <span>部門：${escapeHtml(request.department || '未設定')}</span>
        <span>申請項目：${escapeHtml(request.expense_item)}</span>
        <span>費用類別：${escapeHtml(request.category_name || request.category)}</span>
        <span>申請金額：${escapeHtml(formatMoney(request.amount))}</span>
        <span>${escapeHtml(invoiceText)}</span>
        <span>審核狀態：${escapeHtml(request.status_label)}</span>
        <span>${escapeHtml(deliveryText)}</span>
        <p class="result-reminder">您可請將送出結果截圖，使用Line傳給主管，提醒審核</p>
      </div>
    `;
  }

  function showResultPage() {
    elements.requestSection.hidden = true;
    elements.resultSection.hidden = false;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      elements.resultTitle.focus({ preventScroll: true });
    });
  }

  function showRequestPage() {
    elements.resultSection.hidden = true;
    elements.requestSection.hidden = false;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  async function loadBootstrap() {
    try {
      const data = await api('/api/bootstrap');
      state.categories = data.categories || [];
      state.employees = data.employees || [];
      state.unitsById = new Map((data.units || []).map((unit) => [Number(unit.id), unit]));
      renderBootstrap();
      setState('可申請');
    } catch (error) {
      setState('讀取失敗');
      elements.submitResult.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('發票照片讀取失敗'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('發票照片格式無法讀取'));
      image.src = dataUrl;
    });
  }

  async function compressInvoice(file) {
    if (!file) return {};
    if (!file.type.startsWith('image/')) throw new Error('發票請上傳圖片檔');

    const dataUrl = await readAsDataUrl(file);
    const image = await loadImage(dataUrl);
    const maxSide = 1600;
    const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * ratio));
    const height = Math.max(1, Math.round(image.height * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, width, height);
    const invoiceDataUrl = canvas.toDataURL('image/jpeg', 0.78);

    return {
      invoice_data_url: invoiceDataUrl,
      invoice_name: file.name || 'invoice.jpg',
      invoice_mime: 'image/jpeg'
    };
  }

  async function payloadFromForm(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    delete data.invoice_file;
    data.amount = Number(data.amount);
    return {
      ...data,
      ...(await compressInvoice(selectedInvoiceFile()))
    };
  }

  function handleInvoiceInputChange(changedInput) {
    const otherInput = changedInput === elements.invoiceInput ? elements.invoiceCameraInput : elements.invoiceInput;
    if (changedInput.files.length && otherInput) otherInput.value = '';
    renderInvoicePreview();
  }

  async function submitExpense(event) {
    event.preventDefault();
    if (!elements.expenseForm.checkValidity()) {
      elements.expenseForm.reportValidity();
      setState('請補齊欄位');
      elements.submitResult.innerHTML = '<div class="empty-state">請先填妥所有必填欄位，再送出申請。</div>';
      return;
    }

    elements.submitButton.disabled = true;
    elements.submitButton.textContent = '送出中';
    setState('送出中');

    try {
      const data = await api('/api/expense-requests', {
        method: 'POST',
        body: JSON.stringify(await payloadFromForm(elements.expenseForm))
      });
      elements.submitResult.innerHTML = resultHtml(data.request, data.notification_delivery || data.line_delivery);
      showResultPage();
      elements.expenseForm.reset();
      state.invoiceMode = '';
      elements.occurredOn.value = today();
      renderEmployeeContext();
      renderInvoiceMode();
      setState('已送出');
    } catch (error) {
      elements.submitResult.innerHTML = `<div class="empty-state">送出失敗：${escapeHtml(error.message)}</div>`;
      showResultPage();
      setState('送出失敗');
    } finally {
      elements.submitButton.disabled = false;
      elements.submitButton.textContent = '送出申請';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    [
      'loadState',
      'expenseForm',
      'employeeSelect',
      'employeeContext',
      'requestUnitSelect',
      'categorySelect',
      'occurredOn',
      'invoiceInput',
      'invoiceCameraInput',
      'invoiceCameraPanel',
      'invoiceUploadPanel',
      'invoicePreview',
      'submitButton',
      'submitResult',
      'requestSection',
      'resultSection',
      'resultTitle',
      'newRequestButton'
    ].forEach((id) => {
      elements[id] = byId(id);
    });
    elements.invoiceModeButtons = Array.from(document.querySelectorAll('[data-invoice-mode]'));

    elements.expenseForm.addEventListener('submit', submitExpense);
    elements.newRequestButton.addEventListener('click', showRequestPage);
    elements.expenseForm.addEventListener('reset', () => {
      window.setTimeout(() => {
        state.invoiceMode = '';
        renderInvoiceMode();
      }, 0);
    });
    elements.employeeSelect.addEventListener('change', renderEmployeeContext);
    elements.invoiceModeButtons.forEach((button) => {
      button.addEventListener('click', () => setInvoiceMode(button.dataset.invoiceMode));
    });
    elements.invoiceInput.addEventListener('change', () => handleInvoiceInputChange(elements.invoiceInput));
    elements.invoiceCameraInput.addEventListener('change', () => handleInvoiceInputChange(elements.invoiceCameraInput));
    renderInvoiceMode();
    loadBootstrap();
  });
}());
