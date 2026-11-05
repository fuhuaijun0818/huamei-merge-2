import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_STORE_FILE = resolve(process.cwd(), ".local-data", "supply-chain", "operations.json");
const STORE_FILE = String(process.env.HUAMEI_SUPPLY_CHAIN_STORE_FILE || "").trim();
const memoryMode = STORE_FILE === ":memory:";
const storeFile = memoryMode ? "" : resolve(STORE_FILE || DEFAULT_STORE_FILE);
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;
let memoryState = null;
let operationQueue = Promise.resolve();

const text = (value, max = 120) => String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${randomUUID()}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const fail = (code, message, status = 400, details = []) => Object.assign(new Error(message), { code, status, details });
const emptyTenant = () => ({ materials:[], inventoryBatches:[], imports:[], events:[], revision:0 });
const emptyState = () => ({ schemaVersion:1, tenants:{} });

const readState = async () => {
  if (memoryMode) {
    memoryState ||= emptyState();
    return clone(memoryState);
  }
  try {
    const parsed = JSON.parse(await readFile(storeFile, "utf8"));
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.tenants || typeof parsed.tenants !== "object") throw new Error("invalid");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw fail("SUPPLY_CHAIN_STORE_INVALID", "供应链数据文件无法读取", 500);
  }
};
const writeState = async (state) => {
  if (memoryMode) {
    memoryState = clone(state);
    return;
  }
  await mkdir(dirname(storeFile), { recursive:true });
  await writeFile(storeFile, `${JSON.stringify(state, null, 2)}\n`, { encoding:"utf8", mode:0o600 });
};
const withState = (operation) => {
  const run = operationQueue.then(async () => {
    const state = await readState();
    const result = await operation(state);
    await writeState(state);
    return result;
  });
  operationQueue = run.catch(() => {});
  return run;
};
const tenantState = (state, tenantId) => {
  const key = text(tenantId, 120) || "default";
  state.tenants[key] ||= emptyTenant();
  const tenant = state.tenants[key];
  for (const field of ["materials", "inventoryBatches", "imports", "events"]) if (!Array.isArray(tenant[field])) tenant[field] = [];
  return tenant;
};
const appendEvent = (tenant, type, actor, detail) => {
  tenant.events.unshift({ id:uid("scevt"), type, actor:text(actor, 120) || "system", detail:text(detail, 240), at:nowIso() });
  tenant.events = tenant.events.slice(0, 10_000);
};

const parseCsv = (value) => {
  const source = String(value || "").replace(/^\uFEFF/, "");
  if (!source.trim()) throw fail("SUPPLY_CHAIN_CSV_EMPTY", "CSV文件没有内容");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (quoted) throw fail("SUPPLY_CHAIN_CSV_INVALID", "CSV存在未闭合的引号");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length > MAX_ROWS + 1) throw fail("SUPPLY_CHAIN_CSV_TOO_MANY_ROWS", `单次最多导入${MAX_ROWS}行`);
  return rows;
};
const headerKey = (value) => text(value, 80).toLowerCase().replace(/[\s_-]+/g, "");
const aliases = Object.freeze({
  sku:["sku","skucode","耗材sku","sku编码","耗材编码"],
  name:["name","耗材名称","名称"],
  category:["category","分类","耗材分类"],
  unit:["unit","单位"],
  package_spec:["packagespec","包装规格","规格"],
  moq:["moq","最小起订量","起订量"],
  supplier:["supplier","供应商"],
  lead_time_days:["leadtimedays","交期天数","采购周期","交期"],
  warehouse:["warehouse","仓库"],
  location:["location","库位"],
  batch_no:["batchno","批次号","批号"],
  sterile_batch_no:["sterilebatchno","灭菌批次号"],
  expiry_date:["expirydate","有效期","失效日期","到期日期"],
  available_quantity:["availablequantity","可用数量","现有库存"],
  reserved_quantity:["reservedquantity","预留数量"],
  quarantine_quantity:["quarantinequantity","隔离数量"]
});
const columnIndex = (headers) => {
  const normalized = headers.map(headerKey);
  return Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, normalized.findIndex((header) => names.map(headerKey).includes(header))]));
};
const cell = (row, columns, key) => columns[key] >= 0 ? text(row[columns[key]], 160) : "";
const dateOnly = (value) => {
  const raw = text(value, 40).replace(/\//g, "-");
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) return "";
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : "";
};
const quantity = (value) => {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1000) / 1000 : null;
};
const materialView = (item, today) => ({
  ...clone(item),
  stock_available:item.stock_available || 0,
  stock_reserved:item.stock_reserved || 0,
  stock_quarantine:item.stock_quarantine || 0,
  lot_count:item.lot_count || 0,
  nearest_expiry:item.nearest_expiry || null,
  expiry_status:item.nearest_expiry ? item.nearest_expiry < today ? "expired" : item.nearest_expiry <= addDays(today, 90) ? "expiring" : "normal" : "no_stock"
});
const addDays = (dateString, days) => {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

export async function getSupplyChainOverview({ tenantId } = {}) {
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    const currentDate = today();
    const stockByMaterial = new Map();
    for (const batch of tenant.inventoryBatches) {
      const current = stockByMaterial.get(batch.sku) || { available:0, expired_available:0, reserved:0, quarantine:0, lots:0, nearest_expiry:null };
      if (batch.expiry_date < currentDate) current.expired_available += Number(batch.available_quantity) || 0;
      else current.available += Number(batch.available_quantity) || 0;
      current.reserved += Number(batch.reserved_quantity) || 0;
      current.quarantine += Number(batch.quarantine_quantity) || 0;
      current.lots += 1;
      if (!current.nearest_expiry || batch.expiry_date < current.nearest_expiry) current.nearest_expiry = batch.expiry_date;
      stockByMaterial.set(batch.sku, current);
    }
    const materials = tenant.materials.map((material) => {
      const stock = stockByMaterial.get(material.sku) || {};
      return materialView({ ...material, stock_available:stock.available, stock_expired:stock.expired_available, stock_reserved:stock.reserved, stock_quarantine:stock.quarantine, lot_count:stock.lots, nearest_expiry:stock.nearest_expiry }, currentDate);
    });
    const inventory = tenant.inventoryBatches.map((batch) => ({
      ...clone(batch),
      expiry_status:batch.expiry_date < currentDate ? "expired" : batch.expiry_date <= addDays(currentDate, 90) ? "expiring" : "normal"
    }));
    return {
      materials,
      inventory,
      imports:clone(tenant.imports.slice(0, 30)),
      events:clone(tenant.events.slice(0, 100)),
      metrics:{
        material_count:materials.length,
        lot_count:inventory.length,
        available_quantity:Math.round(inventory.filter((item) => item.expiry_status !== "expired").reduce((sum, item) => sum + Number(item.available_quantity || 0), 0) * 1000) / 1000,
        expired_available_quantity:Math.round(inventory.filter((item) => item.expiry_status === "expired").reduce((sum, item) => sum + Number(item.available_quantity || 0), 0) * 1000) / 1000,
        expiring_lot_count:inventory.filter((item) => item.expiry_status === "expiring").length,
        expired_lot_count:inventory.filter((item) => item.expiry_status === "expired").length
      },
      revision:tenant.revision
    };
  });
}

export async function importSupplyChainCsv({ tenantId, actor, type, payload = {} } = {}) {
  const csv = String(payload.csv_text || "");
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) throw fail("SUPPLY_CHAIN_CSV_TOO_LARGE", "CSV文件不能超过2MB");
  const rows = parseCsv(csv);
  if (rows.length < 2) throw fail("SUPPLY_CHAIN_CSV_INVALID", "CSV至少需要表头和一行数据");
  const columns = columnIndex(rows[0]);
  if (columns.sku < 0) throw fail("SUPPLY_CHAIN_CSV_INVALID", "CSV缺少SKU列");
  if (type === "materials" && (columns.name < 0 || columns.unit < 0)) throw fail("SUPPLY_CHAIN_CSV_INVALID", "耗材CSV必须包含耗材名称和单位");
  if (type === "inventory" && (columns.warehouse < 0 || columns.batch_no < 0 || columns.expiry_date < 0)) {
    throw fail("SUPPLY_CHAIN_CSV_INVALID", "库存CSV必须包含仓库、批次号和有效期");
  }
  if (!["materials", "inventory"].includes(type)) throw fail("SUPPLY_CHAIN_IMPORT_TYPE_INVALID", "不支持的导入类型");
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    const errors = [];
    const staged = [];
    const seen = new Set();
    for (let index = 1; index < rows.length; index += 1) {
      const line = index + 1;
      if (rows[index].every((value) => !String(value).trim())) continue;
      const row = rows[index];
      const sku = cell(row, columns, "sku").toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_.-]{1,79}$/.test(sku)) {
        errors.push({ line, field:"sku", message:"SKU格式无效" });
        continue;
      }
      if (type === "materials") {
        const name = cell(row, columns, "name");
        const unit = cell(row, columns, "unit");
        if (!name) errors.push({ line, field:"name", message:"耗材名称不能为空" });
        if (!unit) errors.push({ line, field:"unit", message:"单位不能为空" });
        const moqRaw = cell(row, columns, "moq");
        const leadRaw = cell(row, columns, "lead_time_days");
        const moq = moqRaw ? Number(moqRaw) : 1;
        const leadTime = leadRaw ? Number(leadRaw) : 0;
        if (!Number.isInteger(moq) || moq < 1) errors.push({ line, field:"moq", message:"MOQ必须是大于0的整数" });
        if (!Number.isInteger(leadTime) || leadTime < 0 || leadTime > 365) errors.push({ line, field:"lead_time_days", message:"交期必须是0至365天的整数" });
        if (seen.has(sku)) errors.push({ line, field:"sku", message:"文件内SKU重复" });
        seen.add(sku);
        staged.push({ sku, name, category:cell(row, columns, "category") || "未分类", unit, package_spec:cell(row, columns, "package_spec"), moq, supplier:cell(row, columns, "supplier"), lead_time_days:leadTime });
      } else {
        const warehouse = cell(row, columns, "warehouse");
        const batchNo = cell(row, columns, "batch_no");
        const expiryDate = dateOnly(cell(row, columns, "expiry_date"));
        const available = quantity(cell(row, columns, "available_quantity"));
        const reserved = quantity(cell(row, columns, "reserved_quantity"));
        const quarantine = quantity(cell(row, columns, "quarantine_quantity"));
        if (!warehouse) errors.push({ line, field:"warehouse", message:"仓库不能为空" });
        if (!batchNo) errors.push({ line, field:"batch_no", message:"批次号不能为空" });
        if (!expiryDate) errors.push({ line, field:"expiry_date", message:"有效期必须是有效日期" });
        if (available === null) errors.push({ line, field:"available_quantity", message:"可用数量必须是非负数字" });
        if (reserved === null) errors.push({ line, field:"reserved_quantity", message:"预留数量必须是非负数字" });
        if (quarantine === null) errors.push({ line, field:"quarantine_quantity", message:"隔离数量必须是非负数字" });
        const key = [sku, warehouse.toLowerCase(), batchNo.toLowerCase(), expiryDate].join("|");
        if (seen.has(key)) errors.push({ line, field:"batch_no", message:"文件内同一SKU/仓库/批次/有效期重复" });
        seen.add(key);
        staged.push({ sku, warehouse, location:cell(row, columns, "location"), batch_no:batchNo, sterile_batch_no:cell(row, columns, "sterile_batch_no"), expiry_date:expiryDate, available_quantity:available ?? 0, reserved_quantity:reserved ?? 0, quarantine_quantity:quarantine ?? 0 });
      }
    }
    if (errors.length) throw fail("SUPPLY_CHAIN_IMPORT_INVALID", `CSV中有${errors.length}项错误，未写入任何数据`, 400, errors.slice(0, 50));
    const timestamp = nowIso();
    let created = 0;
    let updated = 0;
    if (type === "materials") {
      for (const value of staged) {
        const existing = tenant.materials.find((item) => item.sku === value.sku);
        if (existing) {
          Object.assign(existing, value, { updated_at:timestamp });
          updated += 1;
        } else {
          tenant.materials.push({ id:uid("scmaterial"), ...value, created_at:timestamp, updated_at:timestamp });
          created += 1;
        }
      }
    } else {
      const known = new Map(tenant.materials.map((item) => [item.sku, item]));
      const missing = staged.filter((item) => !known.has(item.sku));
      if (missing.length) throw fail("SUPPLY_CHAIN_MATERIAL_NOT_FOUND", "库存中存在未导入的SKU，请先导入耗材主数据", 400, missing.slice(0, 50).map((item) => ({ sku:item.sku })));
      for (const value of staged) {
        const material = known.get(value.sku);
        const existing = tenant.inventoryBatches.find((item) => item.sku === value.sku && item.warehouse === value.warehouse && item.batch_no === value.batch_no && item.expiry_date === value.expiry_date);
        if (existing) {
          Object.assign(existing, value, { material_id:material.id, updated_at:timestamp });
          updated += 1;
        } else {
          tenant.inventoryBatches.push({ id:uid("scbatch"), material_id:material.id, ...value, created_at:timestamp, updated_at:timestamp });
          created += 1;
        }
      }
    }
    const result = { id:uid("scimport"), type, file_name:text(payload.file_name, 160) || `${type}.csv`, created, updated, total:staged.length, actor:text(actor, 120) || "system", at:timestamp };
    tenant.imports.unshift(result);
    tenant.imports = tenant.imports.slice(0, 200);
    appendEvent(tenant, `supply_chain.${type}.imported`, actor, `${result.file_name} · 新增${created} · 更新${updated}`);
    tenant.revision += 1;
    return clone(result);
  });
}

const csvValue = (value) => {
  let textValue = String(value ?? "");
  if (/^[=+\-@]/.test(textValue)) textValue = `'${textValue}`;
  return /[",\n\r]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
};
export async function exportSupplyChainCsv({ tenantId, type } = {}) {
  const overview = await getSupplyChainOverview({ tenantId });
  const rows = type === "inventory"
    ? [
      ["SKU", "耗材名称", "仓库", "库位", "批次号", "灭菌批次号", "有效期", "可用数量", "预留数量", "隔离数量", "效期状态"],
      ...overview.inventory.map((item) => {
        const material = overview.materials.find((candidate) => candidate.sku === item.sku);
        return [item.sku, material?.name || "", item.warehouse, item.location, item.batch_no, item.sterile_batch_no, item.expiry_date, item.available_quantity, item.reserved_quantity, item.quarantine_quantity, item.expiry_status];
      })
    ]
    : [
      ["SKU", "耗材名称", "分类", "单位", "包装规格", "MOQ", "供应商", "交期天数", "可用库存", "批次数量", "最近有效期", "效期状态"],
      ...overview.materials.map((item) => [item.sku, item.name, item.category, item.unit, item.package_spec, item.moq, item.supplier, item.lead_time_days, item.stock_available, item.lot_count, item.nearest_expiry, item.expiry_status])
    ];
  const content = `\uFEFF${rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}\r\n`;
  return {
    buffer:Buffer.from(content, "utf8"),
    file_name:`${type === "inventory" ? "库存批次" : "耗材主数据"}_${today()}.csv`
  };
}
