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
const emptyTenant = () => ({ materials:[], inventoryBatches:[], procedureBoms:[], surgeries:[], consumptions:[], inTransit:[], imports:[], events:[], revision:0 });
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
  for (const field of ["materials", "inventoryBatches", "procedureBoms", "surgeries", "consumptions", "inTransit", "imports", "events"]) if (!Array.isArray(tenant[field])) tenant[field] = [];
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
  quarantine_quantity:["quarantinequantity","隔离数量"],
  quantity:["quantity","数量","在途数量"],
  procedure_code:["procedurecode","术式编码","项目编码"],
  procedure_name:["procedurename","术式名称","项目名称"],
  standard_quantity:["standardquantity","标准用量","单台用量"],
  version:["version","版本"],
  surgery_id:["surgeryid","手术编号","手术id"],
  surgery_date:["surgerydate","手术日期","排程日期"],
  doctor:["doctor","医生","主刀医生"],
  department:["department","科室"],
  status:["status","状态"],
  complexity:["complexity","复杂度"],
  used_quantity:["usedquantity","领用数量"],
  returned_quantity:["returnedquantity","退回数量"],
  wasted_quantity:["wastedquantity","报废数量"],
  actual_consumed_quantity:["actualconsumedquantity","实际消耗数量","实际用量"],
  po_number:["ponumber","采购单号","在途单号"],
  expected_date:["expecteddate","预计到货日期","到货日期"]
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
    const horizonEnd = addDays(currentDate, 30);
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
    const usableStock = new Map();
    for (const batch of tenant.inventoryBatches) {
      if (batch.expiry_date >= currentDate) usableStock.set(batch.sku, (usableStock.get(batch.sku) || 0) + Number(batch.available_quantity || 0));
    }
    const latestBoms = new Map();
    for (const bom of tenant.procedureBoms) {
      const key = `${bom.procedure_code}|${bom.sku}`;
      if (!latestBoms.has(key) || Number(bom.version) > Number(latestBoms.get(key).version)) latestBoms.set(key, bom);
    }
    const plannedSurgeries = tenant.surgeries.filter((item) => item.status === "planned" && item.surgery_date >= currentDate && item.surgery_date <= horizonEnd);
    const demandBySku = new Map();
    const bomWarnings = [];
    for (const surgery of plannedSurgeries) {
      const procedureBoms = [...latestBoms.values()].filter((bom) => bom.procedure_code === surgery.procedure_code);
      if (!procedureBoms.length) {
        bomWarnings.push({ surgery_id:surgery.surgery_id, procedure_code:surgery.procedure_code, message:"术式没有配置BOM，未计入需求" });
        continue;
      }
      for (const bom of procedureBoms) demandBySku.set(bom.sku, (demandBySku.get(bom.sku) || 0) + Number(bom.standard_quantity || 0));
    }
    const incomingBySku = new Map();
    for (const item of tenant.inTransit) {
      if (item.expected_date >= currentDate && item.expected_date <= horizonEnd) incomingBySku.set(item.sku, (incomingBySku.get(item.sku) || 0) + Number(item.quantity || 0));
    }
    const materialBySku = new Map(tenant.materials.map((item) => [item.sku, item]));
    const purchaseRecommendations = [...demandBySku.entries()].map(([sku, demand]) => {
      const material = materialBySku.get(sku);
      const available = usableStock.get(sku) || 0;
      const incoming = incomingBySku.get(sku) || 0;
      const netRequirement = Math.max(0, demand - available - incoming);
      const moq = Math.max(1, Number(material?.moq) || 1);
      return {
        sku,
        material_name:material?.name || sku,
        demand_quantity:Math.round(demand * 1000) / 1000,
        available_quantity:Math.round(available * 1000) / 1000,
        incoming_quantity:Math.round(incoming * 1000) / 1000,
        net_requirement:Math.round(netRequirement * 1000) / 1000,
        moq,
        recommended_quantity:netRequirement > 0 ? Math.ceil(netRequirement / moq) * moq : 0,
        supplier:material?.supplier || null,
        lead_time_days:Number(material?.lead_time_days) || 0
      };
    }).filter((item) => item.demand_quantity > 0 || item.recommended_quantity > 0);
    const surgeryById = new Map(tenant.surgeries.map((item) => [item.surgery_id, item]));
    const anomalyGroups = new Map();
    for (const consumption of tenant.consumptions) {
      const surgery = surgeryById.get(consumption.surgery_id);
      if (!surgery || surgery.status !== "completed") continue;
      const expected = Number(latestBoms.get(`${surgery.procedure_code}|${consumption.sku}`)?.standard_quantity);
      if (!Number.isFinite(expected) || expected <= 0) continue;
      const key = [surgery.doctor, surgery.department, surgery.procedure_code, consumption.sku].join("|");
      const group = anomalyGroups.get(key) || {
        doctor:surgery.doctor,
        department:surgery.department,
        procedure_code:surgery.procedure_code,
        procedure_name:surgery.procedure_name,
        sku:consumption.sku,
        material_name:materialBySku.get(consumption.sku)?.name || consumption.sku,
        surgeries:new Set(),
        expected_quantity:0,
        actual_quantity:0,
        wasted_quantity:0
      };
      group.surgeries.add(surgery.surgery_id);
      group.expected_quantity += expected;
      group.actual_quantity += Number(consumption.actual_consumed_quantity || 0);
      group.wasted_quantity += Number(consumption.wasted_quantity || 0);
      anomalyGroups.set(key, group);
    }
    const anomalies = [...anomalyGroups.values()].map((group) => {
      const { surgeries, ...summary } = group;
      const caseCount = group.surgeries.size;
      const ratio = group.expected_quantity > 0 ? group.actual_quantity / group.expected_quantity : 0;
      return {
        ...summary,
        case_count:caseCount,
        expected_quantity:Math.round(group.expected_quantity * 1000) / 1000,
        actual_quantity:Math.round(group.actual_quantity * 1000) / 1000,
        wasted_quantity:Math.round(group.wasted_quantity * 1000) / 1000,
        ratio:Math.round(ratio * 100) / 100,
        status:caseCount >= 2 && ratio >= 1.5 ? "review_required" : "normal",
        note:caseCount >= 2 && ratio >= 1.5 ? "实际消耗达到BOM标准1.5倍，请核查术式复杂度、套包、退库或记录差异" : ""
      };
    }).filter((item) => item.status === "review_required").sort((a, b) => b.ratio - a.ratio);
    return {
      materials,
      inventory,
      procedure_boms:clone([...latestBoms.values()]),
      surgeries:clone(tenant.surgeries.filter((item) => item.surgery_date >= currentDate).sort((a, b) => a.surgery_date.localeCompare(b.surgery_date)).slice(0, 500)),
      consumptions:clone(tenant.consumptions.slice(0, 2000)),
      in_transit:clone(tenant.inTransit.slice(0, 1000)),
      purchase_recommendations:purchaseRecommendations.sort((a, b) => b.recommended_quantity - a.recommended_quantity),
      anomaly_reviews:anomalies,
      bom_warnings:bomWarnings.slice(0, 100),
      imports:clone(tenant.imports.slice(0, 30)),
      events:clone(tenant.events.slice(0, 100)),
      metrics:{
        material_count:materials.length,
        lot_count:inventory.length,
        available_quantity:Math.round(inventory.filter((item) => item.expiry_status !== "expired").reduce((sum, item) => sum + Number(item.available_quantity || 0), 0) * 1000) / 1000,
        expired_available_quantity:Math.round(inventory.filter((item) => item.expiry_status === "expired").reduce((sum, item) => sum + Number(item.available_quantity || 0), 0) * 1000) / 1000,
        expiring_lot_count:inventory.filter((item) => item.expiry_status === "expiring").length,
        expired_lot_count:inventory.filter((item) => item.expiry_status === "expired").length,
        bom_count:[...latestBoms.values()].length,
        planned_surgery_count:plannedSurgeries.length,
        recommendation_count:purchaseRecommendations.filter((item) => item.recommended_quantity > 0).length,
        anomaly_count:anomalies.length
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
  if (!["materials", "inventory", "bom", "surgeries", "consumption", "in-transit"].includes(type)) {
    throw fail("SUPPLY_CHAIN_IMPORT_TYPE_INVALID", "不支持的导入类型");
  }
  const columns = columnIndex(rows[0]);
  if (type !== "surgeries" && columns.sku < 0) throw fail("SUPPLY_CHAIN_CSV_INVALID", "CSV缺少SKU列");
  if (type === "materials" && (columns.name < 0 || columns.unit < 0)) throw fail("SUPPLY_CHAIN_CSV_INVALID", "耗材CSV必须包含耗材名称和单位");
  if (type === "inventory" && (columns.warehouse < 0 || columns.batch_no < 0 || columns.expiry_date < 0)) {
    throw fail("SUPPLY_CHAIN_CSV_INVALID", "库存CSV必须包含仓库、批次号和有效期");
  }
  if (type === "bom" && (columns.procedure_code < 0 || columns.procedure_name < 0 || columns.standard_quantity < 0)) {
    throw fail("SUPPLY_CHAIN_CSV_INVALID", "BOM CSV必须包含术式编码、术式名称和标准用量");
  }
  if (type === "surgeries" && (columns.surgery_id < 0 || columns.surgery_date < 0 || columns.procedure_code < 0 || columns.doctor < 0 || columns.department < 0)) {
    throw fail("SUPPLY_CHAIN_CSV_INVALID", "手术排程CSV必须包含手术编号、日期、术式编码、医生和科室");
  }
  if (type === "consumption" && (columns.surgery_id < 0 || columns.actual_consumed_quantity < 0)) {
    throw fail("SUPPLY_CHAIN_CSV_INVALID", "实际消耗CSV必须包含手术编号、SKU和实际消耗数量");
  }
  if (type === "in-transit" && (columns.po_number < 0 || columns.quantity < 0 || columns.expected_date < 0)) {
    throw fail("SUPPLY_CHAIN_CSV_INVALID", "在途采购CSV必须包含采购单号、数量、SKU和预计到货日期");
  }
  return withState(async (state) => {
    const tenant = tenantState(state, tenantId);
    const errors = [];
    const staged = [];
    const seen = new Set();
    for (let index = 1; index < rows.length; index += 1) {
      const line = index + 1;
      if (rows[index].every((value) => !String(value).trim())) continue;
      const row = rows[index];
      if (type === "surgeries") {
        const surgeryId = cell(row, columns, "surgery_id").toUpperCase();
        const surgeryDate = dateOnly(cell(row, columns, "surgery_date"));
        const procedureCode = cell(row, columns, "procedure_code").toUpperCase();
        const procedureName = cell(row, columns, "procedure_name");
        const doctor = cell(row, columns, "doctor");
        const department = cell(row, columns, "department");
        const status = cell(row, columns, "status").toLowerCase() || "planned";
        if (!/^[A-Z0-9][A-Z0-9_.-]{1,79}$/.test(surgeryId)) errors.push({ line, field:"surgery_id", message:"手术编号格式无效" });
        if (!surgeryDate) errors.push({ line, field:"surgery_date", message:"手术日期无效" });
        if (!/^[A-Z0-9][A-Z0-9_.-]{1,79}$/.test(procedureCode)) errors.push({ line, field:"procedure_code", message:"术式编码格式无效" });
        if (!doctor) errors.push({ line, field:"doctor", message:"医生不能为空" });
        if (!department) errors.push({ line, field:"department", message:"科室不能为空" });
        if (!["planned", "completed", "cancelled"].includes(status)) errors.push({ line, field:"status", message:"状态只能是planned、completed或cancelled" });
        if (seen.has(surgeryId)) errors.push({ line, field:"surgery_id", message:"文件内手术编号重复" });
        seen.add(surgeryId);
        staged.push({ surgery_id:surgeryId, surgery_date:surgeryDate, procedure_code:procedureCode, procedure_name:procedureName, doctor, department, status, complexity:cell(row, columns, "complexity") || "standard" });
        continue;
      }
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
      } else if (type === "inventory") {
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
      } else if (type === "bom") {
        const procedureCode = cell(row, columns, "procedure_code").toUpperCase();
        const procedureName = cell(row, columns, "procedure_name");
        const standardQuantity = quantity(cell(row, columns, "standard_quantity"));
        const version = Number(cell(row, columns, "version") || 1);
        if (!/^[A-Z0-9][A-Z0-9_.-]{1,79}$/.test(procedureCode)) errors.push({ line, field:"procedure_code", message:"术式编码格式无效" });
        if (!procedureName) errors.push({ line, field:"procedure_name", message:"术式名称不能为空" });
        if (!standardQuantity || standardQuantity <= 0) errors.push({ line, field:"standard_quantity", message:"标准用量必须大于0" });
        if (!Number.isInteger(version) || version < 1) errors.push({ line, field:"version", message:"版本必须是正整数" });
        const key = `${procedureCode}|${sku}|${version}`;
        if (seen.has(key)) errors.push({ line, field:"sku", message:"文件内同一术式、SKU和版本重复" });
        seen.add(key);
        staged.push({ procedure_code:procedureCode, procedure_name:procedureName, sku, standard_quantity:standardQuantity ?? 0, version });
      } else if (type === "consumption") {
        const surgeryId = cell(row, columns, "surgery_id").toUpperCase();
        const actual = quantity(cell(row, columns, "actual_consumed_quantity"));
        const used = quantity(cell(row, columns, "used_quantity"));
        const returned = quantity(cell(row, columns, "returned_quantity"));
        const wasted = quantity(cell(row, columns, "wasted_quantity"));
        if (!surgeryId) errors.push({ line, field:"surgery_id", message:"手术编号不能为空" });
        if (actual === null || actual <= 0) errors.push({ line, field:"actual_consumed_quantity", message:"实际消耗数量必须大于0" });
        if ([used, returned, wasted].some((value) => value === null)) errors.push({ line, field:"quantity", message:"领用、退回和报废数量必须是非负数字" });
        const key = `${surgeryId}|${sku}`;
        if (seen.has(key)) errors.push({ line, field:"sku", message:"文件内同一手术和SKU重复" });
        seen.add(key);
        staged.push({ surgery_id:surgeryId, sku, actual_consumed_quantity:actual ?? 0, used_quantity:used ?? 0, returned_quantity:returned ?? 0, wasted_quantity:wasted ?? 0 });
      } else {
        const poNumber = cell(row, columns, "po_number");
        const expectedDate = dateOnly(cell(row, columns, "expected_date"));
        const incomingQuantity = quantity(cell(row, columns, "quantity"));
        if (!poNumber) errors.push({ line, field:"po_number", message:"采购单号不能为空" });
        if (!expectedDate) errors.push({ line, field:"expected_date", message:"预计到货日期无效" });
        if (!incomingQuantity || incomingQuantity <= 0) errors.push({ line, field:"quantity", message:"在途数量必须大于0" });
        const key = `${poNumber}|${sku}`;
        if (seen.has(key)) errors.push({ line, field:"sku", message:"文件内同一采购单和SKU重复" });
        seen.add(key);
        staged.push({ po_number:poNumber, sku, quantity:incomingQuantity ?? 0, expected_date:expectedDate, supplier:cell(row, columns, "supplier") });
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
    } else if (type === "inventory") {
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
    } else if (type === "bom") {
      const known = new Set(tenant.materials.map((item) => item.sku));
      const missing = staged.filter((item) => !known.has(item.sku));
      if (missing.length) throw fail("SUPPLY_CHAIN_MATERIAL_NOT_FOUND", "BOM中存在未导入的SKU，请先导入耗材主数据", 400, missing.slice(0, 50).map((item) => ({ sku:item.sku })));
      for (const value of staged) {
        const existing = tenant.procedureBoms.find((item) => item.procedure_code === value.procedure_code && item.sku === value.sku && item.version === value.version);
        if (existing) {
          Object.assign(existing, value, { updated_at:timestamp });
          updated += 1;
        } else {
          tenant.procedureBoms.push({ id:uid("scbom"), ...value, created_at:timestamp, updated_at:timestamp });
          created += 1;
        }
      }
    } else if (type === "surgeries") {
      for (const value of staged) {
        const existing = tenant.surgeries.find((item) => item.surgery_id === value.surgery_id);
        if (existing) {
          Object.assign(existing, value, { updated_at:timestamp });
          updated += 1;
        } else {
          tenant.surgeries.push({ id:uid("scsurgery"), ...value, created_at:timestamp, updated_at:timestamp });
          created += 1;
        }
      }
    } else if (type === "consumption") {
      const knownSurgeries = new Set(tenant.surgeries.map((item) => item.surgery_id));
      const knownMaterials = new Set(tenant.materials.map((item) => item.sku));
      const missingSurgery = staged.find((item) => !knownSurgeries.has(item.surgery_id));
      const missingMaterial = staged.find((item) => !knownMaterials.has(item.sku));
      if (missingSurgery) throw fail("SUPPLY_CHAIN_SURGERY_NOT_FOUND", "实际消耗中的手术编号不存在，请先导入手术排程", 400, [{ surgery_id:missingSurgery.surgery_id }]);
      if (missingMaterial) throw fail("SUPPLY_CHAIN_MATERIAL_NOT_FOUND", "实际消耗中的SKU不存在，请先导入耗材主数据", 400, [{ sku:missingMaterial.sku }]);
      for (const value of staged) {
        const existing = tenant.consumptions.find((item) => item.surgery_id === value.surgery_id && item.sku === value.sku);
        if (existing) {
          Object.assign(existing, value, { updated_at:timestamp });
          updated += 1;
        } else {
          tenant.consumptions.push({ id:uid("scconsumption"), ...value, created_at:timestamp, updated_at:timestamp });
          created += 1;
        }
      }
    } else {
      const known = new Set(tenant.materials.map((item) => item.sku));
      const missing = staged.find((item) => !known.has(item.sku));
      if (missing) throw fail("SUPPLY_CHAIN_MATERIAL_NOT_FOUND", "在途采购中的SKU不存在，请先导入耗材主数据", 400, [{ sku:missing.sku }]);
      for (const value of staged) {
        const existing = tenant.inTransit.find((item) => item.po_number === value.po_number && item.sku === value.sku);
        if (existing) {
          Object.assign(existing, value, { updated_at:timestamp });
          updated += 1;
        } else {
          tenant.inTransit.push({ id:uid("scintransit"), ...value, created_at:timestamp, updated_at:timestamp });
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
