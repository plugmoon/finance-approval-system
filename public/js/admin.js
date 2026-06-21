(function () {
  const state = {
    user: null,
    units: [],
    categories: [],
    employees: [],
    requests: [],
    summary: null,
    profile: null
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

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
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

  function field(form, name) {
    return form.elements.namedItem(name);
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
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      invoice_data_url: canvas.toDataURL('image/jpeg', 0.78),
      invoice_name: file.name || 'invoice.jpg',
      invoice_mime: 'image/jpeg'
    };
  }

  async function requestPayloadFromForm(form) {
    const data = formObject(form);
    if (!isAdmin()) {
      data.employee_id = state.user.id;
      data.status = 'pending';
    }
    return {
      ...data,
      ...(await compressInvoice(elements.adminInvoiceInput.files[0]))
    };
  }

  function formObject(form) {
    const data = {};
    for (const [key, value] of new FormData(form).entries()) {
      if (value instanceof File) continue;
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        data[key] = Array.isArray(data[key]) ? [...data[key], value] : [data[key], value];
      } else {
        data[key] = value;
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'amount')) data.amount = Number(data.amount);
    return data;
  }

  function setMessage(element, text, type) {
    element.textContent = text || '';
    element.className = `form-message ${type || ''}`;
  }

  function showAdmin(user) {
    state.user = user;
    elements.loginView.hidden = true;
    elements.adminApp.hidden = false;
    elements.sessionBox.hidden = false;
    elements.sessionName.textContent = user.name || user.username;
    applyRoleUi();
  }

  function showLogin() {
    state.user = null;
    document.body.classList.remove('employee-mode');
    elements.loginView.hidden = false;
    elements.adminApp.hidden = true;
    elements.sessionBox.hidden = true;
  }

  function isAdmin() {
    return state.user?.role === 'admin';
  }

  function applyRoleUi() {
    const admin = isAdmin();
    document.body.classList.toggle('employee-mode', !admin);
    document.querySelectorAll('[data-admin-only]').forEach((element) => {
      element.hidden = !admin;
    });
    const profileTab = document.querySelector('[data-tab="profile"]');
    if (profileTab) profileTab.hidden = Number(state.user?.id) === 0;
    if (elements.adminTabs) elements.adminTabs.hidden = false;
    if (elements.sessionName) elements.sessionName.hidden = !admin;
    if (elements.exportLink) elements.exportLink.hidden = !admin;
    elements.resetRequestButton.hidden = !admin;
    elements.requestEditorPanel.hidden = !admin;
    field(elements.requestForm, 'status').disabled = !admin;
    field(elements.requestForm, 'employee_id').disabled = !admin;
    field(elements.requestForm, 'rejection_reason').disabled = !admin;
    field(elements.profileForm, 'name').disabled = !admin;
    field(elements.profileForm, 'department').disabled = !admin;
    if (!admin) {
      fillEmployeeSelect(elements.adminEmployeeSelect, state.user?.id);
      fillRequestUnitSelect(state.user?.id, '');
    }
    const activeTab = document.querySelector('.tab-button.active')?.dataset.tab || 'dashboard';
    switchTab(activeTab);
  }

  function fillCategorySelect(select, selectedId) {
    select.innerHTML = state.categories.map((category) => {
      const selected = Number(category.id) === Number(selectedId) ? ' selected' : '';
      return `<option value="${category.id}"${selected}>${escapeHtml(category.name)}</option>`;
    }).join('');
  }

  function fillUnitSelect(select, selectedIds) {
    const selectedSet = new Set((Array.isArray(selectedIds) ? selectedIds : [selectedIds])
      .filter((value) => value !== '' && value !== undefined && value !== null)
      .map((value) => Number(value)));
    select.innerHTML = state.units.map((unit) => {
      const selected = selectedSet.has(Number(unit.id)) ? ' selected' : '';
      return `<option value="${unit.id}"${selected}>${escapeHtml(unit.name)}</option>`;
    }).join('');
  }

  function employeeUnits(employee) {
    const unitIds = employee ? (employee.unit_ids || [employee.unit_id]) : [];
    return unitIds
      .map((id) => state.units.find((unit) => Number(unit.id) === Number(id)))
      .filter(Boolean);
  }

  function fillRequestUnitSelect(selectedEmployeeId, selectedUnitId) {
    const employee = state.employees.find((item) => Number(item.id) === Number(selectedEmployeeId));
    const units = employeeUnits(employee);
    if (!units.length) {
      elements.adminRequestUnitSelect.innerHTML = '<option value="">請先選擇員工</option>';
      return;
    }
    elements.adminRequestUnitSelect.innerHTML = units.map((unit, index) => {
      const selected = Number(unit.id) === Number(selectedUnitId || units[0].id) || (!selectedUnitId && index === 0);
      return `<option value="${unit.id}"${selected ? ' selected' : ''}>${escapeHtml(unit.name)}</option>`;
    }).join('');
  }

  function fillEmployeeSelect(select, selectedId) {
    const rows = state.employees
      .filter((employee) => employee.status === 'active' || Number(employee.id) === Number(selectedId))
      .sort((a, b) => (
        (a.unit_names || [a.unit_name]).join('、').localeCompare((b.unit_names || [b.unit_name]).join('、'), 'zh-Hant')
        || a.department.localeCompare(b.department, 'zh-Hant')
        || a.employee_no.localeCompare(b.employee_no, 'zh-Hant')
      ));
    select.innerHTML = rows.map((employee) => {
      const selected = Number(employee.id) === Number(selectedId) ? ' selected' : '';
      const unitText = (employee.unit_names || [employee.unit_name]).filter(Boolean).join('、') || '未設定單位';
      return `<option value="${employee.id}"${selected}>${escapeHtml(employee.employee_no)} ${escapeHtml(employee.name)}｜${escapeHtml(unitText)} / ${escapeHtml(employee.department || '未設定部門')}</option>`;
    }).join('');
  }

  function renderSummary() {
    const summary = state.summary || {
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      approved_amount: 0,
      pending_amount: 0
    };
    const cards = [
      ['待審核', summary.pending, '筆'],
      ['已同意金額', formatMoney(summary.approved_amount), ''],
      ['待審金額', formatMoney(summary.pending_amount), ''],
      ['全部申請', summary.total, '筆']
    ];
    elements.metricGrid.innerHTML = cards.map(([label, value, unit]) => `
      <article class="metric-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}${unit ? `<small>${escapeHtml(unit)}</small>` : ''}</strong>
      </article>
    `).join('');
  }

  function statusBadge(status, label) {
    return `<span class="status-badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
  }

  function renderRequests() {
    if (!state.requests.length) {
      elements.requestRows.innerHTML = '<tr><td colspan="7">目前沒有財務申請資料。</td></tr>';
      return;
    }

    elements.requestRows.innerHTML = state.requests.map((item) => {
      const canEdit = isAdmin() || item.status === 'pending';
      const actions = isAdmin()
        ? `
          <button class="text-button" type="button" data-action="edit-request" data-id="${item.id}">編輯</button>
          <button class="text-button danger" type="button" data-action="delete-request" data-id="${item.id}">刪除</button>
        `
          : canEdit
          ? `<button class="text-button" type="button" data-action="edit-request" data-id="${item.id}">編輯</button>`
          : '<span class="locked-text">已審核鎖定</span>';
      return `
      <tr>
        <td>
          <strong>${escapeHtml(item.request_no)}</strong><br>
          <span>${escapeHtml(item.occurred_on)}</span>
        </td>
        <td>${escapeHtml(item.employee_name)}<br><span>${escapeHtml(item.employee_no)}</span></td>
        <td>${escapeHtml(item.unit_name || '未設定單位')}<br><span>${escapeHtml(item.department || '未設定部門')}</span></td>
        <td>${escapeHtml(item.expense_item)}<br><span>${escapeHtml(item.category_name || item.category)}</span>${item.invoice ? `<br><a href="${escapeHtml(item.invoice.url)}" target="_blank" rel="noopener">查看發票</a>` : ''}</td>
        <td class="amount-cell">${escapeHtml(formatMoney(item.amount))}</td>
        <td>${statusBadge(item.status, item.status_label)}</td>
        <td>
          <div class="row-actions">
            ${actions}
          </div>
        </td>
      </tr>
    `;
    }).join('');
  }

  function renderEmployees() {
    if (!state.employees.length) {
      elements.employeeRows.innerHTML = '<tr><td colspan="6">目前沒有員工資料。</td></tr>';
      return;
    }

    elements.employeeRows.innerHTML = state.employees.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.employee_no)}</strong></td>
        <td>${escapeHtml(item.name)}${item.account ? `<br><span>${escapeHtml(item.account)}</span>` : ''}</td>
        <td>${escapeHtml((item.unit_names || [item.unit_name]).filter(Boolean).join('、') || '未設定單位')}<br><span>${escapeHtml(item.department || '未設定部門')}</span></td>
        <td>${item.role === 'admin' ? '管理員' : '員工'}</td>
        <td>${item.status === 'active' ? '啟用' : '停用'}</td>
        <td>
          <div class="row-actions">
            <button class="text-button" type="button" data-action="edit-employee" data-id="${item.id}">編輯</button>
            <button class="text-button danger" type="button" data-action="delete-employee" data-id="${item.id}">刪除</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  function renderCategories() {
    if (!state.categories.length) {
      elements.categoryRows.innerHTML = '<tr><td colspan="2">目前沒有費用類別。</td></tr>';
      return;
    }

    elements.categoryRows.innerHTML = state.categories.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td>
          <div class="row-actions">
            <button class="text-button" type="button" data-action="edit-category" data-id="${item.id}">編輯</button>
            <button class="text-button danger" type="button" data-action="delete-category" data-id="${item.id}">刪除</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  function renderUnits() {
    if (!state.units.length) {
      elements.unitRows.innerHTML = '<tr><td colspan="2">目前沒有單位。</td></tr>';
      return;
    }

    elements.unitRows.innerHTML = state.units.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td>
          <div class="row-actions">
            <button class="text-button" type="button" data-action="edit-unit" data-id="${item.id}">編輯</button>
            <button class="text-button danger" type="button" data-action="delete-unit" data-id="${item.id}">刪除</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  function renderAdminInvoicePreview(existingInvoice) {
    const file = elements.adminInvoiceInput.files[0];
    if (file) {
      const sizeKb = Math.round(file.size / 1024);
      elements.adminInvoicePreview.innerHTML = `
        <strong>${escapeHtml(file.name || '發票照片')}</strong>
        <span>${escapeHtml(file.type || 'image')}，約 ${sizeKb} KB</span>
      `;
      return;
    }
    if (existingInvoice?.url) {
      elements.adminInvoicePreview.innerHTML = `<a href="${escapeHtml(existingInvoice.url)}" target="_blank" rel="noopener">查看已上傳發票：${escapeHtml(existingInvoice.original_name || existingInvoice.filename)}</a>`;
      return;
    }
    elements.adminInvoicePreview.textContent = '可在新增或編輯時上傳發票照片。';
  }

  async function loadSummary() {
    state.summary = await api('/api/admin/summary');
    renderSummary();
  }

  async function loadUnits() {
    state.units = await api('/api/admin/units');
    renderUnits();
    const selected = Array.from(elements.employeeUnitSelect.selectedOptions || []).map((option) => option.value);
    fillUnitSelect(elements.employeeUnitSelect, selected);
  }

  async function loadCategories() {
    state.categories = await api('/api/admin/categories');
    renderCategories();
    fillCategorySelect(elements.adminCategorySelect, field(elements.requestForm, 'category_id').value);
  }

  async function loadEmployees() {
    state.employees = await api('/api/admin/employees');
    renderEmployees();
    fillEmployeeSelect(elements.adminEmployeeSelect, field(elements.requestForm, 'employee_id').value);
    fillRequestUnitSelect(field(elements.requestForm, 'employee_id').value, field(elements.requestForm, 'unit_id').value);
  }

  async function loadRequests() {
    const query = new URLSearchParams();
    if (elements.requestKeyword.value.trim()) query.set('keyword', elements.requestKeyword.value.trim());
    if (elements.requestStatus.value) query.set('status', elements.requestStatus.value);
    state.requests = await api(`/api/admin/requests?${query.toString()}`);
    renderRequests();
  }

  function renderProfile() {
    const profile = state.profile;
    if (!profile) return;
    field(elements.profileForm, 'employee_no').value = profile.employee_no || '';
    field(elements.profileForm, 'role_label').value = profile.role === 'admin' ? '管理員' : '員工';
    field(elements.profileForm, 'name').value = profile.name || '';
    field(elements.profileForm, 'department').value = profile.department || '';
    field(elements.profileForm, 'unit_names').value = (profile.unit_names || [profile.unit_name]).filter(Boolean).join('、') || '未設定';
    field(elements.profileForm, 'account').value = profile.account || '';
    field(elements.profileForm, 'password').value = '';
  }

  async function loadProfile() {
    if (Number(state.user?.id) === 0) {
      state.profile = null;
      return;
    }
    try {
      state.profile = await api('/api/admin/profile');
      renderProfile();
      setMessage(elements.profileMessage, '', '');
    } catch (error) {
      state.profile = null;
      setMessage(elements.profileMessage, error.message, 'error');
    }
  }

  async function loadAll() {
    await Promise.all([loadUnits(), loadCategories()]);
    await Promise.all([loadSummary(), loadEmployees(), loadRequests(), loadProfile()]);
    applyRoleUi();
  }

  async function login(event) {
    event.preventDefault();
    setMessage(elements.loginMessage, '登入中...', '');
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(formObject(elements.loginForm))
      });
      showAdmin(data.user);
      await loadAll();
      setMessage(elements.loginMessage, '', '');
    } catch (error) {
      setMessage(elements.loginMessage, error.message, 'error');
    }
  }

  async function checkSession() {
    try {
      const data = await api('/api/admin/me');
      showAdmin(data.user);
      await loadAll();
    } catch {
      showLogin();
    }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
    showLogin();
  }

  function switchTab(tabName) {
    if (!isAdmin() && !['requests', 'profile'].includes(tabName)) {
      tabName = 'requests';
    }
    document.querySelectorAll('.tab-button').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tabName);
    });
    elements.dashboardPanel.hidden = !isAdmin() || tabName !== 'dashboard';
    elements.requestsPanel.hidden = tabName !== 'requests';
    elements.profilePanel.hidden = Number(state.user?.id) === 0 || tabName !== 'profile';
    elements.employeesPanel.hidden = !isAdmin() || tabName !== 'employees';
    elements.settingsPanel.hidden = !isAdmin() || tabName !== 'settings';
    if (!isAdmin() && !field(elements.requestForm, 'id').value) {
      elements.requestEditorPanel.hidden = true;
    }
  }

  function resetRequestForm() {
    elements.requestForm.reset();
    field(elements.requestForm, 'id').value = '';
    field(elements.requestForm, 'occurred_on').value = today();
    elements.requestFormTitle.textContent = '新增財務紀錄';
    const employeeId = isAdmin() ? '' : state.user?.id;
    fillEmployeeSelect(elements.adminEmployeeSelect, employeeId);
    field(elements.requestForm, 'employee_id').value = employeeId || '';
    fillRequestUnitSelect(employeeId || field(elements.requestForm, 'employee_id').value, '');
    fillCategorySelect(elements.adminCategorySelect, '');
    renderAdminInvoicePreview(null);
    elements.requestEditorPanel.hidden = !isAdmin();
    setMessage(elements.requestMessage, '', '');
  }

  function resetEmployeeForm() {
    elements.employeeForm.reset();
    field(elements.employeeForm, 'id').value = '';
    elements.employeeFormTitle.textContent = '新增員工';
    fillUnitSelect(elements.employeeUnitSelect, []);
    setMessage(elements.employeeMessage, '', '');
  }

  function resetCategoryForm() {
    elements.categoryForm.reset();
    field(elements.categoryForm, 'id').value = '';
    elements.categoryFormTitle.textContent = '新增費用類別';
    setMessage(elements.categoryMessage, '', '');
  }

  function resetUnitForm() {
    elements.unitForm.reset();
    field(elements.unitForm, 'id').value = '';
    elements.unitFormTitle.textContent = '新增單位';
    setMessage(elements.unitMessage, '', '');
  }

  function editRequest(id) {
    const item = state.requests.find((request) => Number(request.id) === Number(id));
    if (!item) return;
    if (!isAdmin() && item.status !== 'pending') {
      setMessage(elements.requestMessage, '只有待審核的申請可以修改。', 'error');
      return;
    }
    elements.requestFormTitle.textContent = `編輯 ${item.request_no}`;
    field(elements.requestForm, 'id').value = item.id;
    fillEmployeeSelect(elements.adminEmployeeSelect, item.employee_id);
    fillRequestUnitSelect(item.employee_id, item.unit_id);
    fillCategorySelect(elements.adminCategorySelect, item.category_id);
    field(elements.requestForm, 'employee_id').value = item.employee_id;
    field(elements.requestForm, 'unit_id').value = item.unit_id || '';
    field(elements.requestForm, 'status').value = item.status;
    field(elements.requestForm, 'category_id').value = item.category_id || '';
    field(elements.requestForm, 'amount').value = item.amount;
    field(elements.requestForm, 'occurred_on').value = item.occurred_on;
    field(elements.requestForm, 'expense_item').value = item.expense_item;
    field(elements.requestForm, 'description').value = item.description;
    field(elements.requestForm, 'note').value = item.note || '';
    field(elements.requestForm, 'rejection_reason').value = item.rejection_reason || '';
    field(elements.requestForm, 'invoice_file').value = '';
    renderAdminInvoicePreview(item.invoice);
    elements.requestEditorPanel.hidden = false;
    setMessage(elements.requestMessage, '', '');
    elements.requestForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function editEmployee(id) {
    const item = state.employees.find((employee) => Number(employee.id) === Number(id));
    if (!item) return;
    elements.employeeFormTitle.textContent = `編輯 ${item.name}`;
    field(elements.employeeForm, 'id').value = item.id;
    field(elements.employeeForm, 'employee_no').value = item.employee_no;
    field(elements.employeeForm, 'name').value = item.name;
    fillUnitSelect(elements.employeeUnitSelect, item.unit_ids || [item.unit_id]);
    field(elements.employeeForm, 'department').value = item.department || '';
    field(elements.employeeForm, 'role').value = item.role;
    field(elements.employeeForm, 'status').value = item.status;
    field(elements.employeeForm, 'account').value = item.account || '';
    field(elements.employeeForm, 'password').value = '';
    setMessage(elements.employeeMessage, '', '');
    elements.employeeForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function editCategory(id) {
    const item = state.categories.find((category) => Number(category.id) === Number(id));
    if (!item) return;
    elements.categoryFormTitle.textContent = `編輯 ${item.name}`;
    field(elements.categoryForm, 'id').value = item.id;
    field(elements.categoryForm, 'name').value = item.name;
    setMessage(elements.categoryMessage, '', '');
  }

  function editUnit(id) {
    const item = state.units.find((unit) => Number(unit.id) === Number(id));
    if (!item) return;
    elements.unitFormTitle.textContent = `編輯 ${item.name}`;
    field(elements.unitForm, 'id').value = item.id;
    field(elements.unitForm, 'name').value = item.name;
    setMessage(elements.unitMessage, '', '');
  }

  async function saveRequest(event) {
    event.preventDefault();
    if (!elements.requestForm.checkValidity()) {
      elements.requestForm.reportValidity();
      return;
    }
    const id = field(elements.requestForm, 'id').value;
    if (!isAdmin() && !id) {
      setMessage(elements.requestMessage, '員工請由前台送出新的財務申請。', 'error');
      return;
    }
    const method = id ? 'PUT' : 'POST';
    const path = id ? `/api/admin/requests/${encodeURIComponent(id)}` : '/api/admin/requests';
    setMessage(elements.requestMessage, '儲存中...', '');
    try {
      await api(path, { method, body: JSON.stringify(await requestPayloadFromForm(elements.requestForm)) });
      resetRequestForm();
      await Promise.all([loadSummary(), loadRequests()]);
      setMessage(elements.requestMessage, '已儲存財務資料。', 'success');
    } catch (error) {
      setMessage(elements.requestMessage, error.message, 'error');
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (!elements.profileForm.checkValidity()) {
      elements.profileForm.reportValidity();
      return;
    }
    setMessage(elements.profileMessage, '儲存中...', '');
    try {
      state.profile = await api('/api/admin/profile', {
        method: 'PUT',
        body: JSON.stringify(formObject(elements.profileForm))
      });
      renderProfile();
      state.user.name = state.profile.name;
      state.user.username = state.profile.account;
      elements.sessionName.textContent = state.profile.name;
      await Promise.all([loadSummary(), loadEmployees(), loadRequests()]);
      setMessage(elements.profileMessage, '已儲存個人資料。', 'success');
    } catch (error) {
      setMessage(elements.profileMessage, error.message, 'error');
    }
  }

  async function saveEmployee(event) {
    event.preventDefault();
    if (!elements.employeeForm.checkValidity()) {
      elements.employeeForm.reportValidity();
      return;
    }
    const id = field(elements.employeeForm, 'id').value;
    const method = id ? 'PUT' : 'POST';
    const path = id ? `/api/admin/employees/${encodeURIComponent(id)}` : '/api/admin/employees';
    setMessage(elements.employeeMessage, '儲存中...', '');
    try {
      await api(path, { method, body: JSON.stringify(formObject(elements.employeeForm)) });
      resetEmployeeForm();
      await loadEmployees();
      setMessage(elements.employeeMessage, '已儲存員工資料。', 'success');
    } catch (error) {
      setMessage(elements.employeeMessage, error.message, 'error');
    }
  }

  async function saveCategory(event) {
    event.preventDefault();
    if (!elements.categoryForm.checkValidity()) {
      elements.categoryForm.reportValidity();
      return;
    }
    const id = field(elements.categoryForm, 'id').value;
    const method = id ? 'PUT' : 'POST';
    const path = id ? `/api/admin/categories/${encodeURIComponent(id)}` : '/api/admin/categories';
    setMessage(elements.categoryMessage, '儲存中...', '');
    try {
      await api(path, { method, body: JSON.stringify(formObject(elements.categoryForm)) });
      resetCategoryForm();
      await Promise.all([loadCategories(), loadRequests()]);
      setMessage(elements.categoryMessage, '已儲存費用類別。', 'success');
    } catch (error) {
      setMessage(elements.categoryMessage, error.message, 'error');
    }
  }

  async function saveUnit(event) {
    event.preventDefault();
    if (!elements.unitForm.checkValidity()) {
      elements.unitForm.reportValidity();
      return;
    }
    const id = field(elements.unitForm, 'id').value;
    const method = id ? 'PUT' : 'POST';
    const path = id ? `/api/admin/units/${encodeURIComponent(id)}` : '/api/admin/units';
    setMessage(elements.unitMessage, '儲存中...', '');
    try {
      await api(path, { method, body: JSON.stringify(formObject(elements.unitForm)) });
      resetUnitForm();
      await Promise.all([loadUnits(), loadEmployees(), loadRequests()]);
      setMessage(elements.unitMessage, '已儲存單位。', 'success');
    } catch (error) {
      setMessage(elements.unitMessage, error.message, 'error');
    }
  }

  async function deleteRequest(id) {
    if (!window.confirm('確定要刪除此筆財務資料？')) return;
    await api(`/api/admin/requests/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await Promise.all([loadSummary(), loadRequests()]);
  }

  async function deleteEmployee(id) {
    if (!window.confirm('確定要刪除此員工？')) return;
    await api(`/api/admin/employees/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadEmployees();
  }

  async function deleteCategory(id) {
    if (!window.confirm('確定要刪除此費用類別？既有申請會保留原類別名稱。')) return;
    await api(`/api/admin/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await Promise.all([loadCategories(), loadRequests()]);
  }

  async function deleteUnit(id) {
    if (!window.confirm('確定要刪除此單位？若仍有員工使用，系統會拒絕刪除。')) return;
    await api(`/api/admin/units/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await Promise.all([loadUnits(), loadEmployees(), loadRequests()]);
  }

  function bindEvents() {
    elements.loginForm.addEventListener('submit', login);
    elements.logoutButton.addEventListener('click', logout);
    document.querySelectorAll('.tab-button').forEach((button) => {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
    });

    elements.requestForm.addEventListener('submit', saveRequest);
    elements.employeeForm.addEventListener('submit', saveEmployee);
    elements.profileForm.addEventListener('submit', saveProfile);
    elements.categoryForm.addEventListener('submit', saveCategory);
    elements.unitForm.addEventListener('submit', saveUnit);
    elements.resetRequestButton.addEventListener('click', resetRequestForm);
    elements.resetEmployeeButton.addEventListener('click', resetEmployeeForm);
    elements.resetCategoryButton.addEventListener('click', resetCategoryForm);
    elements.resetUnitButton.addEventListener('click', resetUnitForm);
    elements.adminEmployeeSelect.addEventListener('change', () => {
      fillRequestUnitSelect(elements.adminEmployeeSelect.value, '');
    });
    elements.adminInvoiceInput.addEventListener('change', () => renderAdminInvoicePreview(null));
    elements.requestKeyword.addEventListener('input', () => loadRequests().catch(() => {}));
    elements.requestStatus.addEventListener('change', () => loadRequests().catch(() => {}));

    elements.requestRows.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      if (button.dataset.action === 'edit-request') editRequest(button.dataset.id);
      if (button.dataset.action === 'delete-request') deleteRequest(button.dataset.id).catch((error) => {
        setMessage(elements.requestMessage, error.message, 'error');
      });
    });

    elements.employeeRows.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      if (button.dataset.action === 'edit-employee') editEmployee(button.dataset.id);
      if (button.dataset.action === 'delete-employee') deleteEmployee(button.dataset.id).catch((error) => {
        setMessage(elements.employeeMessage, error.message, 'error');
      });
    });

    elements.categoryRows.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      if (button.dataset.action === 'edit-category') editCategory(button.dataset.id);
      if (button.dataset.action === 'delete-category') deleteCategory(button.dataset.id).catch((error) => {
        setMessage(elements.categoryMessage, error.message, 'error');
      });
    });

    elements.unitRows.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      if (button.dataset.action === 'edit-unit') editUnit(button.dataset.id);
      if (button.dataset.action === 'delete-unit') deleteUnit(button.dataset.id).catch((error) => {
        setMessage(elements.unitMessage, error.message, 'error');
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    [
      'sessionBox',
      'sessionName',
      'logoutButton',
      'loginView',
      'loginForm',
      'loginMessage',
      'adminApp',
      'adminTabs',
      'dashboardPanel',
      'requestsPanel',
      'profilePanel',
      'employeesPanel',
      'settingsPanel',
      'metricGrid',
      'profileForm',
      'profileMessage',
      'requestForm',
      'requestEditorPanel',
      'requestFormTitle',
      'requestMessage',
      'resetRequestButton',
      'adminEmployeeSelect',
      'adminRequestUnitSelect',
      'adminCategorySelect',
      'adminInvoiceInput',
      'adminInvoicePreview',
      'requestRows',
      'requestKeyword',
      'requestStatus',
      'exportLink',
      'employeeForm',
      'employeeFormTitle',
      'employeeMessage',
      'resetEmployeeButton',
      'employeeUnitSelect',
      'employeeRows',
      'categoryForm',
      'categoryFormTitle',
      'categoryMessage',
      'resetCategoryButton',
      'categoryRows',
      'unitForm',
      'unitFormTitle',
      'unitMessage',
      'resetUnitButton',
      'unitRows'
    ].forEach((id) => {
      elements[id] = byId(id);
    });

    field(elements.requestForm, 'occurred_on').value = today();
    bindEvents();
    checkSession();
  });
}());
