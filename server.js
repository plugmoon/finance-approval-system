'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const INVOICE_DIR = path.join(DATA_DIR, 'invoices');
const APP_BASE_URL = String(process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret-change-me';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_TARGET_ID = process.env.LINE_TARGET_ID || '';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MAX_BODY_BYTES = 1024 * 1024 * 8;

const sessions = new Map();
const defaultCategoryNames = ['交通費', '餐費', '採購', '住宿費', '交際費', '教育訓練', '其他'];
const defaultUnitNames = ['凱凱美麗產業有限公司', '亞太職業創新協會', '鋼鐵人美食家集團'];
const statusLabels = {
  pending: '待審核',
  approved: '已同意',
  rejected: '不同意'
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

function loadEnvFile(filePath) {
  if (!fssync.existsSync(filePath)) return;
  const lines = fssync.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sessionHash(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(value)).digest('hex');
}

function constantEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expected] = String(storedHash || '').split(':');
  if (!salt || !expected) return false;
  const actual = hashPassword(password, salt).split(':')[1];
  return constantEqual(actual, expected);
}

function cleanText(value, maxLength = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanLongText(value, maxLength = 1500) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function cleanAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('請輸入有效的申請金額');
  return Math.round(number * 100) / 100;
}

function cleanDate(value) {
  const text = cleanText(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : todayDate();
}

function normalizeStatus(value, fallback = 'pending') {
  const status = cleanText(value, 20);
  return Object.prototype.hasOwnProperty.call(statusLabels, status) ? status : fallback;
}

function formatMoney(value) {
  return new Intl.NumberFormat('zh-TW', {
    style: 'currency',
    currency: 'TWD',
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function nextId(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
}

function requestNumber(id) {
  const date = todayDate().replace(/-/g, '');
  return `EXP-${date}-${String(id).padStart(4, '0')}`;
}

function defaultUnits() {
  return defaultUnitNames.map((name, index) => ({
    id: index + 1,
    name,
    created_at: nowIso(),
    updated_at: nowIso()
  }));
}

function defaultCategories() {
  return defaultCategoryNames.map((name, index) => ({
    id: index + 1,
    name,
    created_at: nowIso(),
    updated_at: nowIso()
  }));
}

function normalizeNamedRows(rows, defaults) {
  const source = Array.isArray(rows) && rows.length ? rows : defaults;
  const seen = new Set();
  return source
    .map((row, index) => {
      const name = cleanText(typeof row === 'string' ? row : row.name, 80);
      const id = Number(typeof row === 'object' ? row.id : index + 1) || index + 1;
      if (!name || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        name,
        created_at: row.created_at || nowIso(),
        updated_at: row.updated_at || nowIso()
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
}

function findById(rows, id) {
  return rows.find((row) => Number(row.id) === Number(id));
}

function findByName(rows, name) {
  const normalized = cleanText(name, 80).toLowerCase();
  if (!normalized) return null;
  return rows.find((row) => row.name.toLowerCase() === normalized) || null;
}

function fallbackUnit(units) {
  return findByName(units, '鋼鐵人美食家集團') || units[0] || { id: 1, name: '鋼鐵人美食家集團' };
}

function unitFromInput(input, units) {
  const byId = findById(units, input.unit_id);
  if (byId) return byId;
  const byName = findByName(units, input.unit_name || input.unit);
  return byName || fallbackUnit(units);
}

function unitIdsFromInput(input, units) {
  const raw = input.unit_ids ?? input.unit_id;
  const values = Array.isArray(raw) ? raw : [raw];
  const ids = values
    .map((value) => Number(value))
    .filter((id) => Number.isFinite(id) && findById(units, id));
  if (!ids.length) ids.push(unitFromInput(input, units).id);
  return Array.from(new Set(ids));
}

function unitNamesFromIds(unitIds, units) {
  return unitIds
    .map((id) => findById(units, id))
    .filter(Boolean)
    .map((unit) => unit.name);
}

function requestUnitFromInput(input, employee, units) {
  const unitIds = Array.isArray(employee.unit_ids) && employee.unit_ids.length ? employee.unit_ids : [employee.unit_id];
  const requested = Number(input.unit_id ?? employee.unit_id ?? unitIds[0]);
  const selectedId = unitIds.includes(requested) ? requested : unitIds[0];
  const unit = findById(units, selectedId);
  if (!unit) throw new Error('請選擇有效的申請單位');
  return unit;
}

function categoryFromInput(input, categories) {
  const byId = findById(categories, input.category_id);
  if (byId) return byId;
  const byName = findByName(categories, input.category_name || input.category);
  return byName;
}

function seedStore() {
  const createdAt = nowIso();
  const units = defaultUnits();
  const categories = defaultCategories();
  const defaultUnit = fallbackUnit(units);
  return {
    units,
    categories,
    employees: [
      {
        id: 1,
        employee_no: 'ADM001',
        name: '最高管理員',
        unit_ids: [defaultUnit.id],
        unit_names: [defaultUnit.name],
        unit_id: defaultUnit.id,
        unit_name: defaultUnit.name,
        department: '管理部',
        role: 'admin',
        status: 'active',
        account: ADMIN_USERNAME,
        password_hash: hashPassword(ADMIN_PASSWORD),
        created_at: createdAt,
        updated_at: createdAt
      },
      {
        id: 2,
        employee_no: 'EMP001',
        name: '王小明',
        unit_ids: [defaultUnit.id],
        unit_names: [defaultUnit.name],
        unit_id: defaultUnit.id,
        unit_name: defaultUnit.name,
        department: '營運部',
        role: 'employee',
        status: 'active',
        account: '',
        password_hash: '',
        created_at: createdAt,
        updated_at: createdAt
      },
      {
        id: 3,
        employee_no: 'EMP002',
        name: '陳怡君',
        unit_ids: [1],
        unit_names: ['凱凱美麗產業有限公司'],
        unit_id: 1,
        unit_name: '凱凱美麗產業有限公司',
        department: '行政部',
        role: 'employee',
        status: 'active',
        account: '',
        password_hash: '',
        created_at: createdAt,
        updated_at: createdAt
      }
    ],
    requests: []
  };
}

async function ensureDataStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(INVOICE_DIR, { recursive: true });
  if (!fssync.existsSync(DATA_FILE)) {
    await fs.writeFile(DATA_FILE, `${JSON.stringify(seedStore(), null, 2)}\n`, 'utf8');
  }
}

function normalizeExistingEmployee(row, units) {
  const unitIds = unitIdsFromInput(row, units);
  const unitNames = unitNamesFromIds(unitIds, units);
  const primaryUnit = findById(units, unitIds[0]) || fallbackUnit(units);
  return {
    id: Number(row.id) || 0,
    employee_no: cleanText(row.employee_no, 40),
    name: cleanText(row.name, 80),
    unit_ids: unitIds,
    unit_names: unitNames,
    unit_id: primaryUnit.id,
    unit_name: primaryUnit.name,
    department: cleanText(row.department, 80),
    role: row.role === 'admin' ? 'admin' : 'employee',
    status: row.status === 'inactive' ? 'inactive' : 'active',
    account: cleanText(row.account, 80),
    password_hash: String(row.password_hash || ''),
    created_at: row.created_at || nowIso(),
    updated_at: row.updated_at || nowIso()
  };
}

function normalizeInvoice(input = {}) {
  const filename = cleanText(input.filename || input.invoice_filename || '', 180);
  if (!filename) return null;
  return {
    filename,
    original_name: cleanText(input.original_name || input.invoice_name || filename, 180),
    mime: cleanText(input.mime || input.invoice_mime || 'image/jpeg', 80),
    size: Number(input.size || input.invoice_size) || 0,
    uploaded_at: input.uploaded_at || input.invoice_uploaded_at || nowIso()
  };
}

function normalizeExistingRequest(row, store) {
  const unit = unitFromInput(row, store.units);
  const category = categoryFromInput(row, store.categories);
  const storedCategoryName = cleanText(row.category_name || row.category, 80);
  const invoice = normalizeInvoice(row.invoice || row);
  return {
    id: Number(row.id) || 0,
    request_no: cleanText(row.request_no, 40),
    employee_id: Number(row.employee_id) || 0,
    employee_no: cleanText(row.employee_no, 40),
    employee_name: cleanText(row.employee_name, 80),
    unit_id: unit?.id || null,
    unit_name: unit?.name || cleanText(row.unit_name, 80),
    department: cleanText(row.department, 80),
    expense_item: cleanText(row.expense_item, 120),
    category_id: category ? category.id : (Number(row.category_id) || null),
    category_name: category ? category.name : (storedCategoryName || '其他'),
    amount: Number(row.amount) || 0,
    occurred_on: cleanDate(row.occurred_on),
    description: cleanLongText(row.description, 1500),
    note: cleanLongText(row.note, 1500),
    status: normalizeStatus(row.status),
    rejection_reason: cleanLongText(row.rejection_reason, 800),
    approval_token: String(row.approval_token || randomToken()),
    line_delivery: row.line_delivery || { status: 'pending', message: '' },
    created_by: cleanText(row.created_by, 60) || 'front',
    created_at: row.created_at || nowIso(),
    updated_at: row.updated_at || nowIso(),
    approved_at: row.approved_at || null,
    rejected_at: row.rejected_at || null,
    reviewed_by: cleanText(row.reviewed_by, 80),
    invoice
  };
}

function normalizeStore(store) {
  const units = normalizeNamedRows(store.units, defaultUnits());
  const categories = normalizeNamedRows(store.categories, defaultCategories());
  const normalized = {
    units,
    categories,
    employees: [],
    requests: []
  };
  normalized.employees = Array.isArray(store.employees)
    ? store.employees.map((row) => normalizeExistingEmployee(row, units)).filter((row) => row.id)
    : [];
  normalized.requests = Array.isArray(store.requests)
    ? store.requests.map((row) => normalizeExistingRequest(row, normalized)).filter((row) => row.id)
    : [];
  return normalized;
}

async function readStore() {
  await ensureDataStore();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  return normalizeStore(JSON.parse(raw || '{}'));
}

async function writeStore(store) {
  await ensureDataStore();
  const tempPath = `${DATA_FILE}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(normalizeStore(store), null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, DATA_FILE);
}

function publicEmployee(employee) {
  return {
    id: employee.id,
    employee_no: employee.employee_no,
    name: employee.name,
    unit_ids: employee.unit_ids,
    unit_names: employee.unit_names,
    unit_id: employee.unit_id,
    unit_name: employee.unit_name,
    department: employee.department
  };
}

function adminEmployee(employee) {
  return {
    ...publicEmployee(employee),
    role: employee.role,
    status: employee.status,
    account: employee.account,
    created_at: employee.created_at,
    updated_at: employee.updated_at
  };
}

function publicExpense(expense) {
  return {
    id: expense.id,
    request_no: expense.request_no,
    employee_id: expense.employee_id,
    employee_no: expense.employee_no,
    employee_name: expense.employee_name,
    unit_id: expense.unit_id,
    unit_name: expense.unit_name,
    department: expense.department,
    expense_item: expense.expense_item,
    category_id: expense.category_id,
    category_name: expense.category_name,
    category: expense.category_name,
    amount: expense.amount,
    occurred_on: expense.occurred_on,
    description: expense.description,
    note: expense.note,
    status: expense.status,
    status_label: statusLabels[expense.status],
    rejection_reason: expense.status === 'rejected' ? expense.rejection_reason : '',
    created_at: expense.created_at,
    updated_at: expense.updated_at,
    approved_at: expense.approved_at,
    rejected_at: expense.rejected_at,
    reviewed_by: expense.reviewed_by,
    invoice: expense.invoice ? {
      ...expense.invoice,
      url: invoiceUrl(expense)
    } : null
  };
}

function adminExpense(expense) {
  return {
    ...publicExpense(expense),
    line_delivery: expense.line_delivery,
    created_by: expense.created_by
  };
}

function activeEmployees(store) {
  return store.employees
    .filter((employee) => employee.status === 'active')
    .sort((a, b) => (
      a.unit_names.join('、').localeCompare(b.unit_names.join('、'), 'zh-Hant')
      || a.department.localeCompare(b.department, 'zh-Hant')
      || a.employee_no.localeCompare(b.employee_no, 'zh-Hant')
    ));
}

function normalizeEmployeeInput(body, store, existing = {}) {
  const now = nowIso();
  const input = body.unit_ids !== undefined || body.unit_id !== undefined ? body : existing;
  const unitIds = unitIdsFromInput(input, store.units);
  const unitNames = unitNamesFromIds(unitIds, store.units);
  const primaryUnit = findById(store.units, unitIds[0]) || fallbackUnit(store.units);
  const employee = {
    id: existing.id,
    employee_no: cleanText(body.employee_no ?? existing.employee_no, 40),
    name: cleanText(body.name ?? existing.name, 80),
    unit_ids: unitIds,
    unit_names: unitNames,
    unit_id: primaryUnit.id,
    unit_name: primaryUnit.name,
    department: cleanText(body.department ?? existing.department, 80),
    role: body.role === 'admin' ? 'admin' : 'employee',
    status: body.status === 'inactive' ? 'inactive' : 'active',
    account: cleanText(body.account ?? existing.account, 80),
    password_hash: existing.password_hash || '',
    created_at: existing.created_at || now,
    updated_at: now
  };

  const password = cleanText(body.password, 200);
  if (password) employee.password_hash = hashPassword(password);
  if (!employee.employee_no) throw new Error('請輸入員工編號');
  if (!employee.name) throw new Error('請輸入員工姓名');
  ensureUniqueAccount(store, employee.account, employee.id);
  if (!employee.unit_ids.length) throw new Error('請至少選擇一個單位');
  return employee;
}

function normalizeExpenseInput(body, store, existing = {}, options = {}) {
  const now = nowIso();
  const employee = findById(store.employees, body.employee_id ?? existing.employee_id);
  if (!employee) throw new Error('請選擇有效的員工');
  const requestUnit = requestUnitFromInput(body.unit_id !== undefined ? body : existing, employee, store.units);

  const category = categoryFromInput(body.category_id !== undefined || body.category !== undefined ? body : existing, store.categories);
  if (!category && !existing.category_name) throw new Error('請選擇有效的費用類別');

  const requestedStatus = options.allowStatus ? normalizeStatus(body.status ?? existing.status) : 'pending';
  const statusChanged = existing.status && existing.status !== requestedStatus;
  const expense = {
    id: existing.id,
    request_no: existing.request_no,
    employee_id: employee.id,
    employee_no: employee.employee_no,
    employee_name: employee.name,
    unit_id: requestUnit.id,
    unit_name: requestUnit.name,
    department: employee.department,
    expense_item: cleanText(body.expense_item ?? existing.expense_item, 120),
    category_id: category ? category.id : existing.category_id,
    category_name: category ? category.name : existing.category_name,
    amount: cleanAmount(body.amount ?? existing.amount),
    occurred_on: cleanDate(body.occurred_on ?? existing.occurred_on),
    description: cleanLongText(body.description ?? existing.description, 1500),
    note: cleanLongText(body.note ?? existing.note, 1500),
    status: requestedStatus,
    rejection_reason: cleanLongText(body.rejection_reason ?? existing.rejection_reason, 800),
    approval_token: existing.approval_token || randomToken(),
    line_delivery: existing.line_delivery || { status: 'pending', message: '' },
    created_by: existing.created_by || options.createdBy || 'front',
    created_at: existing.created_at || now,
    updated_at: now,
    approved_at: existing.approved_at || null,
    rejected_at: existing.rejected_at || null,
    reviewed_by: cleanText(body.reviewed_by ?? existing.reviewed_by, 80)
  };

  if (!expense.expense_item) throw new Error('請輸入申請項目');
  if (!expense.description) throw new Error('請輸入內容描述');

  if (expense.status === 'approved' && (!expense.approved_at || statusChanged)) {
    expense.approved_at = now;
    expense.rejected_at = null;
    expense.rejection_reason = '';
    expense.reviewed_by = expense.reviewed_by || '後台管理員';
  }

  if (expense.status === 'rejected' && (!expense.rejected_at || statusChanged)) {
    expense.rejected_at = now;
    expense.approved_at = null;
    expense.reviewed_by = expense.reviewed_by || '後台管理員';
  }

  if (expense.status === 'pending') {
    expense.approved_at = null;
    expense.rejected_at = null;
    expense.reviewed_by = '';
  }

  return expense;
}

function normalizeNamedInput(body, existing = {}) {
  const name = cleanText(body.name ?? existing.name, 80);
  if (!name) throw new Error('請輸入名稱');
  return {
    id: existing.id,
    name,
    created_at: existing.created_at || nowIso(),
    updated_at: nowIso()
  };
}

function invoiceUrl(expense) {
  if (!expense.invoice?.filename) return '';
  const file = encodeURIComponent(expense.invoice.filename);
  return `/api/invoices/${file}?id=${encodeURIComponent(expense.id)}&token=${encodeURIComponent(expense.approval_token)}`;
}

function safeInvoiceFilename(filename) {
  const clean = path.basename(String(filename || ''));
  return /^[a-zA-Z0-9._-]+$/.test(clean) ? clean : '';
}

async function saveInvoiceFromBody(body, expense) {
  const dataUrl = String(body.invoice_data_url || '').trim();
  if (!dataUrl) return null;

  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) throw new Error('發票檔案格式不支援，請上傳 JPG、PNG 或 WebP 圖片');

  const mime = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const extByMime = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  };
  const ext = extByMime[mime];
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length) throw new Error('發票圖片內容為空');
  if (bytes.length > 1024 * 1024 * 5) throw new Error('發票圖片過大，請重新拍攝或壓縮後再上傳');

  const filename = `${expense.request_no}-${randomToken(6)}.${ext}`;
  await fs.writeFile(path.join(INVOICE_DIR, filename), bytes);
  return {
    filename,
    original_name: cleanText(body.invoice_name || `invoice.${ext}`, 180),
    mime,
    size: bytes.length,
    uploaded_at: nowIso()
  };
}

function readCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function isSecureRequest(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `finance_admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'finance_admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function getAdminSession(req) {
  const token = readCookies(req).finance_admin_session;
  if (!token) return null;
  const key = sessionHash(token);
  const session = sessions.get(key);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(key);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireAdmin(req, res) {
  const session = getAdminSession(req);
  if (session) return session;
  writeJson(res, 401, { error: '請先登入後台' });
  return null;
}

function isAdminSession(session) {
  return session?.role === 'admin';
}

function forbid(res) {
  writeJson(res, 403, { error: '權限不足' });
}

function scopedRequests(store, session) {
  if (isAdminSession(session)) return store.requests;
  return store.requests.filter((item) => Number(item.employee_id) === Number(session.id));
}

function publicSessionUser(session) {
  return {
    id: session.id,
    username: session.username,
    name: session.name,
    role: session.role,
    employee_no: session.employee_no || '',
    can_manage: isAdminSession(session)
  };
}

function employeeProfile(employee) {
  return {
    id: employee.id,
    employee_no: employee.employee_no,
    name: employee.name,
    unit_ids: employee.unit_ids,
    unit_names: employee.unit_names,
    unit_id: employee.unit_id,
    unit_name: employee.unit_name,
    department: employee.department,
    role: employee.role,
    status: employee.status,
    account: employee.account
  };
}

function ensureUniqueAccount(store, account, employeeId) {
  if (!account) return;
  const duplicate = store.employees.find((employee) => (
    employee.account === account && Number(employee.id) !== Number(employeeId)
  ));
  if (duplicate) throw new Error('登入帳號已被其他員工使用');
}

function normalizeProfileInput(body, existing, store) {
  const employee = { ...existing };
  employee.name = cleanText(body.name ?? existing.name, 80);
  employee.department = cleanText(body.department ?? existing.department, 80);
  employee.account = cleanText(body.account ?? existing.account, 80);
  const password = cleanText(body.password, 200);
  if (!employee.name) throw new Error('請輸入姓名');
  if (!employee.account) throw new Error('請輸入登入帳號');
  ensureUniqueAccount(store, employee.account, employee.id);
  if (password) employee.password_hash = hashPassword(password);
  employee.updated_at = nowIso();
  return employee;
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function writeText(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function notFound(res) {
  writeJson(res, 404, { error: '找不到資料' });
}

async function parseJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('資料量過大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function requestsToCsv(requests) {
  const headers = [
    'request_no',
    'status',
    'unit_name',
    'department',
    'employee_no',
    'employee_name',
    'category_name',
    'expense_item',
    'amount',
    'occurred_on',
    'description',
    'note',
    'invoice_filename',
    'rejection_reason',
    'created_at',
    'approved_at',
    'rejected_at'
  ];
  const rows = requests.map((item) => headers.map((key) => {
    if (key === 'invoice_filename') return csvEscape(item.invoice?.original_name || item.invoice?.filename || '');
    return csvEscape(item[key]);
  }).join(','));
  return `${headers.join(',')}\n${rows.join('\n')}\n`;
}

function buildReviewUrl(expense, decision) {
  const url = new URL('/review.html', APP_BASE_URL);
  url.searchParams.set('id', expense.id);
  url.searchParams.set('token', expense.approval_token);
  if (decision) url.searchParams.set('decision', decision);
  return url.toString();
}

async function postJson(urlString, payload, headers = {}) {
  const url = new URL(urlString);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) {
          reject(new Error(`LINE API ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve({ raw: text });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function pushLineMessages(messages) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_TARGET_ID) {
    return { status: 'skipped', message: '尚未設定 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_TARGET_ID' };
  }

  try {
    await postJson('https://api.line.me/v2/bot/message/push', {
      to: LINE_TARGET_ID,
      messages
    }, {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    });
    return { status: 'sent', message: '已送出 LINE 群組通知' };
  } catch (error) {
    return { status: 'failed', message: error.message };
  }
}

async function sendLineReviewMessage(expense) {
  const contents = [
    { type: 'text', text: '費用申請待審核', weight: 'bold', size: 'lg', color: '#172026' },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: `申請人：${expense.employee_name}`, margin: 'md', wrap: true },
    { type: 'text', text: `單位：${expense.unit_name}`, wrap: true },
    { type: 'text', text: `部門：${expense.department || '未填'}`, wrap: true },
    { type: 'text', text: `項目：${expense.expense_item}`, wrap: true },
    { type: 'text', text: `類別：${expense.category_name}`, wrap: true },
    { type: 'text', text: `金額：${formatMoney(expense.amount)}`, weight: 'bold', color: '#0f766e' },
    { type: 'text', text: `內容：${expense.description}`, wrap: true },
    { type: 'text', text: `備註：${expense.note || '無'}`, wrap: true, color: '#5b6472' },
    { type: 'text', text: `發票：${expense.invoice ? '已上傳' : '未上傳'}`, wrap: true, color: '#5b6472' }
  ];

  return pushLineMessages([
    {
      type: 'flex',
      altText: `費用申請待審核：${expense.employee_name} ${formatMoney(expense.amount)}`,
      contents: {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', spacing: 'sm', contents },
        footer: {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#0f766e',
              action: { type: 'uri', label: '同意', uri: buildReviewUrl(expense, 'approve') }
            },
            {
              type: 'button',
              style: 'secondary',
              action: { type: 'uri', label: '不同意', uri: buildReviewUrl(expense, 'reject') }
            }
          ]
        }
      }
    }
  ]);
}

async function sendLineDecisionMessage(expense) {
  const decision = expense.status === 'approved' ? '已同意' : '不同意';
  const reason = expense.status === 'rejected' ? `\n不同意理由：${expense.rejection_reason}` : '';
  return pushLineMessages([
    {
      type: 'text',
      text: `費用申請審核結果：${decision}\n申請單：${expense.request_no}\n申請人：${expense.employee_name}\n單位：${expense.unit_name}\n項目：${expense.expense_item}\n金額：${formatMoney(expense.amount)}${reason}`
    }
  ]);
}

function filterRequests(requests, query) {
  const keyword = cleanText(query.get('keyword') || query.get('q') || '').toLowerCase();
  const status = normalizeStatus(query.get('status') || '', '');
  return requests
    .filter((item) => (!status ? true : item.status === status))
    .filter((item) => {
      if (!keyword) return true;
      return [
        item.request_no,
        item.unit_name,
        item.department,
        item.employee_no,
        item.employee_name,
        item.category_name,
        item.expense_item,
        item.description,
        item.note,
        item.rejection_reason
      ].join(' ').toLowerCase().includes(keyword);
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);
}

function buildSummary(requests) {
  const summary = {
    total: requests.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    approved_amount: 0,
    pending_amount: 0
  };
  for (const item of requests) {
    if (item.status === 'pending') {
      summary.pending += 1;
      summary.pending_amount += Number(item.amount) || 0;
    }
    if (item.status === 'approved') {
      summary.approved += 1;
      summary.approved_amount += Number(item.amount) || 0;
    }
    if (item.status === 'rejected') summary.rejected += 1;
  }
  return summary;
}

async function handlePublicApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/healthz') {
    writeJson(res, 200, { ok: true });
    return true;
  }

  const invoiceMatch = pathname.match(/^\/api\/invoices\/([a-zA-Z0-9._-]+)$/);
  if (invoiceMatch && req.method === 'GET') {
    const filename = safeInvoiceFilename(invoiceMatch[1]);
    if (!filename) return notFound(res), true;
    const store = await readStore();
    const expense = store.requests.find((item) => item.invoice?.filename === filename);
    const hasReviewToken = expense
      && Number(url.searchParams.get('id')) === Number(expense.id)
      && url.searchParams.get('token') === expense.approval_token;
    const hasAdminSession = Boolean(getAdminSession(req));
    if (!expense || (!hasReviewToken && !hasAdminSession)) return notFound(res), true;

    try {
      const filePath = path.join(INVOICE_DIR, filename);
      const data = await fs.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': expense.invoice.mime || 'application/octet-stream',
        'Cache-Control': 'private, no-store'
      });
      res.end(data);
    } catch (error) {
      if (error.code === 'ENOENT') return notFound(res), true;
      throw error;
    }
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    const store = await readStore();
    writeJson(res, 200, {
      employees: activeEmployees(store).map(publicEmployee),
      categories: store.categories,
      units: store.units
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/expense-requests') {
    if (!isSameOrigin(req)) return writeJson(res, 403, { error: '來源驗證失敗' }), true;
    const body = await parseJsonBody(req);
    const store = await readStore();
    const id = nextId(store.requests);
    const expense = normalizeExpenseInput(body, store, { id, request_no: requestNumber(id) }, { createdBy: 'front' });
    const invoice = await saveInvoiceFromBody(body, expense);
    if (invoice) expense.invoice = invoice;
    store.requests.push(expense);
    await writeStore(store);

    const delivery = await sendLineReviewMessage(expense);
    const latestStore = await readStore();
    const latestExpense = latestStore.requests.find((item) => item.id === expense.id);
    if (latestExpense) {
      latestExpense.line_delivery = delivery;
      latestExpense.updated_at = nowIso();
      await writeStore(latestStore);
    }

    writeJson(res, 201, {
      request: publicExpense(latestExpense || expense),
      line_delivery: delivery
    });
    return true;
  }

  const reviewMatch = pathname.match(/^\/api\/reviews\/(\d+)$/);
  if (reviewMatch && req.method === 'GET') {
    const store = await readStore();
    const expense = store.requests.find((item) => item.id === Number(reviewMatch[1]));
    if (!expense || expense.approval_token !== url.searchParams.get('token')) return notFound(res), true;
    writeJson(res, 200, { request: publicExpense(expense) });
    return true;
  }

  const approveMatch = pathname.match(/^\/api\/reviews\/(\d+)\/approve$/);
  if (approveMatch && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const store = await readStore();
    const expense = store.requests.find((item) => item.id === Number(approveMatch[1]));
    if (!expense || expense.approval_token !== body.token) return notFound(res), true;
    if (expense.status === 'pending') {
      expense.status = 'approved';
      expense.reviewed_by = 'LINE 審核';
      expense.approved_at = nowIso();
      expense.rejected_at = null;
      expense.rejection_reason = '';
      expense.updated_at = nowIso();
      await writeStore(store);
      await sendLineDecisionMessage(expense);
    }
    writeJson(res, 200, { request: publicExpense(expense) });
    return true;
  }

  const rejectMatch = pathname.match(/^\/api\/reviews\/(\d+)\/reject$/);
  if (rejectMatch && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const reason = cleanLongText(body.reason, 800);
    if (!reason) return writeJson(res, 400, { error: '請填寫不同意的理由' }), true;
    const store = await readStore();
    const expense = store.requests.find((item) => item.id === Number(rejectMatch[1]));
    if (!expense || expense.approval_token !== body.token) return notFound(res), true;
    if (expense.status === 'pending') {
      expense.status = 'rejected';
      expense.reviewed_by = 'LINE 審核';
      expense.rejection_reason = reason;
      expense.rejected_at = nowIso();
      expense.approved_at = null;
      expense.updated_at = nowIso();
      await writeStore(store);
      await sendLineDecisionMessage(expense);
    }
    writeJson(res, 200, { request: publicExpense(expense) });
    return true;
  }

  return false;
}

async function handleAuthApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    if (!isSameOrigin(req)) return writeJson(res, 403, { error: '來源驗證失敗' }), true;
    const body = await parseJsonBody(req);
    const username = cleanText(body.username, 80);
    const password = String(body.password || '');
    const store = await readStore();

    let account = null;
    const employee = store.employees.find((item) => (
      item.status === 'active'
      && item.account
      && item.account === username
      && verifyPassword(password, item.password_hash)
    ));
    if (employee) {
      account = {
        id: employee.id,
        username: employee.account,
        name: employee.name,
        role: employee.role,
        employee_no: employee.employee_no
      };
    } else if (constantEqual(username, ADMIN_USERNAME) && constantEqual(password, ADMIN_PASSWORD)) {
      account = { id: 0, username: ADMIN_USERNAME, name: '最高管理員', role: 'admin' };
    }

    if (!account) return writeJson(res, 401, { error: '帳號或密碼錯誤' }), true;
    const token = randomToken();
    sessions.set(sessionHash(token), {
      ...account,
      expiresAt: Date.now() + SESSION_TTL_MS
    });
    setSessionCookie(req, res, token);
    writeJson(res, 200, { ok: true, user: publicSessionUser(account) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = readCookies(req).finance_admin_session;
    if (token) sessions.delete(sessionHash(token));
    clearSessionCookie(res);
    writeJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function handleAdminApi(req, res, url) {
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/admin/')) return false;
  if (req.method !== 'GET' && !isSameOrigin(req)) return writeJson(res, 403, { error: '來源驗證失敗' }), true;

  const session = requireAdmin(req, res);
  if (!session) return true;

  if (req.method === 'GET' && pathname === '/api/admin/me') {
    writeJson(res, 200, { user: publicSessionUser(session) });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/summary') {
    const store = await readStore();
    writeJson(res, 200, buildSummary(scopedRequests(store, session)));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/profile') {
    const store = await readStore();
    const employee = store.employees.find((item) => Number(item.id) === Number(session.id));
    if (!employee) return writeJson(res, 404, { error: '預設管理員請透過 .env 修改帳號密碼' }), true;
    writeJson(res, 200, employeeProfile(employee));
    return true;
  }

  if (req.method === 'PUT' && pathname === '/api/admin/profile') {
    const body = await parseJsonBody(req);
    const store = await readStore();
    const index = store.employees.findIndex((item) => Number(item.id) === Number(session.id));
    if (index === -1) return writeJson(res, 404, { error: '預設管理員請透過 .env 修改帳號密碼' }), true;
    store.employees[index] = normalizeProfileInput(body, store.employees[index], store);
    await writeStore(store);

    session.username = store.employees[index].account;
    session.name = store.employees[index].name;
    writeJson(res, 200, employeeProfile(store.employees[index]));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/units') {
    const store = await readStore();
    writeJson(res, 200, store.units);
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/units') {
    if (!isAdminSession(session)) return forbid(res), true;
    const body = await parseJsonBody(req);
    const store = await readStore();
    const unit = normalizeNamedInput(body, { id: nextId(store.units) });
    store.units.push(unit);
    await writeStore(store);
    writeJson(res, 201, unit);
    return true;
  }

  const unitMatch = pathname.match(/^\/api\/admin\/units\/(\d+)$/);
  if (unitMatch && req.method === 'PUT') {
    if (!isAdminSession(session)) return forbid(res), true;
    const body = await parseJsonBody(req);
    const store = await readStore();
    const index = store.units.findIndex((item) => item.id === Number(unitMatch[1]));
    if (index === -1) return notFound(res), true;
    store.units[index] = normalizeNamedInput(body, store.units[index]);
    await writeStore(store);
    writeJson(res, 200, store.units[index]);
    return true;
  }

  if (unitMatch && req.method === 'DELETE') {
    if (!isAdminSession(session)) return forbid(res), true;
    const store = await readStore();
    const id = Number(unitMatch[1]);
    if (store.employees.some((employee) => (employee.unit_ids || [employee.unit_id]).some((unitId) => Number(unitId) === id))) {
      return writeJson(res, 409, { error: '此單位仍有員工使用，請先調整員工所屬單位' }), true;
    }
    const next = store.units.filter((item) => item.id !== id);
    if (next.length === store.units.length) return notFound(res), true;
    store.units = next;
    await writeStore(store);
    writeJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/categories') {
    const store = await readStore();
    writeJson(res, 200, store.categories);
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/categories') {
    if (!isAdminSession(session)) return forbid(res), true;
    const body = await parseJsonBody(req);
    const store = await readStore();
    const category = normalizeNamedInput(body, { id: nextId(store.categories) });
    store.categories.push(category);
    await writeStore(store);
    writeJson(res, 201, category);
    return true;
  }

  const categoryMatch = pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
  if (categoryMatch && req.method === 'PUT') {
    if (!isAdminSession(session)) return forbid(res), true;
    const body = await parseJsonBody(req);
    const store = await readStore();
    const index = store.categories.findIndex((item) => item.id === Number(categoryMatch[1]));
    if (index === -1) return notFound(res), true;
    store.categories[index] = normalizeNamedInput(body, store.categories[index]);
    await writeStore(store);
    writeJson(res, 200, store.categories[index]);
    return true;
  }

  if (categoryMatch && req.method === 'DELETE') {
    if (!isAdminSession(session)) return forbid(res), true;
    const store = await readStore();
    const next = store.categories.filter((item) => item.id !== Number(categoryMatch[1]));
    if (next.length === store.categories.length) return notFound(res), true;
    store.categories = next;
    await writeStore(store);
    writeJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/employees') {
    const store = await readStore();
    const employees = isAdminSession(session)
      ? store.employees
      : store.employees.filter((item) => Number(item.id) === Number(session.id));
    writeJson(res, 200, employees.map(adminEmployee).sort((a, b) => a.id - b.id));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/employees') {
    if (!isAdminSession(session)) return forbid(res), true;
    const body = await parseJsonBody(req);
    const store = await readStore();
    const employee = normalizeEmployeeInput(body, store, { id: nextId(store.employees) });
    store.employees.push(employee);
    await writeStore(store);
    writeJson(res, 201, adminEmployee(employee));
    return true;
  }

  const employeeMatch = pathname.match(/^\/api\/admin\/employees\/(\d+)$/);
  if (employeeMatch && req.method === 'PUT') {
    if (!isAdminSession(session)) return forbid(res), true;
    const body = await parseJsonBody(req);
    const id = Number(employeeMatch[1]);
    const store = await readStore();
    const index = store.employees.findIndex((item) => item.id === id);
    if (index === -1) return notFound(res), true;
    store.employees[index] = normalizeEmployeeInput(body, store, store.employees[index]);
    await writeStore(store);
    writeJson(res, 200, adminEmployee(store.employees[index]));
    return true;
  }

  if (employeeMatch && req.method === 'DELETE') {
    if (!isAdminSession(session)) return forbid(res), true;
    const id = Number(employeeMatch[1]);
    const store = await readStore();
    const nextEmployees = store.employees.filter((item) => item.id !== id);
    if (nextEmployees.length === store.employees.length) return notFound(res), true;
    store.employees = nextEmployees;
    await writeStore(store);
    writeJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/requests') {
    const store = await readStore();
    writeJson(res, 200, filterRequests(scopedRequests(store, session), url.searchParams).map(adminExpense));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/requests') {
    if (!isAdminSession(session)) {
      return writeJson(res, 403, { error: '員工請由前台送出新的財務申請' }), true;
    }
    const body = await parseJsonBody(req);
    const store = await readStore();
    const id = nextId(store.requests);
    const expense = normalizeExpenseInput(body, store, { id, request_no: requestNumber(id) }, {
      allowStatus: true,
      createdBy: 'admin'
    });
    const invoice = await saveInvoiceFromBody(body, expense);
    if (invoice) expense.invoice = invoice;
    store.requests.push(expense);
    await writeStore(store);
    writeJson(res, 201, adminExpense(expense));
    return true;
  }

  const requestMatch = pathname.match(/^\/api\/admin\/requests\/(\d+)$/);
  if (requestMatch && req.method === 'PUT') {
    const body = await parseJsonBody(req);
    const id = Number(requestMatch[1]);
    const store = await readStore();
    const index = store.requests.findIndex((item) => item.id === id);
    if (index === -1) return notFound(res), true;
    if (!isAdminSession(session)) {
      if (Number(store.requests[index].employee_id) !== Number(session.id)) return forbid(res), true;
      if (store.requests[index].status !== 'pending') {
        return writeJson(res, 409, { error: '此申請已完成審核，僅待審核項目可以修改' }), true;
      }
      body.employee_id = session.id;
      body.status = 'pending';
    }
    const expense = normalizeExpenseInput(body, store, store.requests[index], { allowStatus: isAdminSession(session) });
    const invoice = await saveInvoiceFromBody(body, expense);
    if (invoice) expense.invoice = invoice;
    store.requests[index] = expense;
    await writeStore(store);
    writeJson(res, 200, adminExpense(store.requests[index]));
    return true;
  }

  if (requestMatch && req.method === 'DELETE') {
    if (!isAdminSession(session)) return forbid(res), true;
    const id = Number(requestMatch[1]);
    const store = await readStore();
    const nextRequests = store.requests.filter((item) => item.id !== id);
    if (nextRequests.length === store.requests.length) return notFound(res), true;
    store.requests = nextRequests;
    await writeStore(store);
    writeJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/export.csv') {
    if (!isAdminSession(session)) return forbid(res), true;
    const store = await readStore();
    const rows = filterRequests(scopedRequests(store, session), url.searchParams);
    writeText(res, 200, requestsToCsv(rows), 'text/csv; charset=utf-8', {
      'Content-Disposition': 'attachment; filename="expense-requests.csv"'
    });
    return true;
  }

  return false;
}

async function handleApi(req, res, url) {
  if (await handlePublicApi(req, res, url)) return true;
  if (await handleAuthApi(req, res, url)) return true;
  if (await handleAdminApi(req, res, url)) return true;
  return false;
}

async function serveStatic(req, res, url) {
  let requestPath = decodeURIComponent(url.pathname);
  if (requestPath === '/') requestPath = '/index.html';
  if (requestPath === '/admin') requestPath = '/admin.html';
  if (requestPath === '/review') requestPath = '/review.html';

  const filePath = path.resolve(PUBLIC_DIR, `.${requestPath}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    writeText(res, 403, 'Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return notFound(res);
    const ext = path.extname(filePath).toLowerCase();
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': ['.html', '.css', '.js'].includes(ext) ? 'no-store' : 'public, max-age=3600'
    });
    res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') return notFound(res);
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const handled = await handleApi(req, res, url);
    if (handled) return;
    await serveStatic(req, res, url);
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 500;
    writeJson(res, status, { error: status === 400 ? 'JSON 格式不正確' : error.message || '系統發生錯誤' });
    console.error(error);
  }
});

ensureDataStore()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Finance approval system running at http://${HOST}:${PORT}`);
      if (!process.env.ADMIN_PASSWORD) {
        console.warn('Default admin password is admin12345. Set ADMIN_PASSWORD before production deployment.');
      }
      if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_TARGET_ID) {
        console.warn('LINE settings are missing. Expense requests will be saved, but LINE push messages will be skipped.');
      }
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
