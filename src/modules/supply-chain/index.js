import { icon } from "../../icons.js";
import { badge, card, closeModal, empty, escapeHtml, formatDate, metric, openModal, pageHead, toast } from "../../ui.js";

const ui = { loaded:false, loading:false, error:"", data:null };
const key = (prefix) => `${prefix}-${crypto.randomUUID()}`.slice(0, 128);
const number = (value) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits:3 }).format(Number(value) || 0);
const expiryLabel = { expired:"已过期", expiring:"90天内到期", normal:"正常", no_stock:"无库存" };
const expiryTone = { expired:"danger", expiring:"warning", normal:"success", no_stock:"outline" };

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials:"same-origin",
      cache:"no-store",
      ...options,
      headers:{ Accept:"application/json", ...(options.body ? { "Content-Type":"application/json" } : {}), ...(options.headers || {}) }
    });
  } catch (error) {
    throw Object.assign(new Error("供应链服务暂时不可用，请稍后重试"), { code:"SUPPLY_CHAIN_NETWORK_UNAVAILABLE", cause:error });
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok) return body.data;
  throw Object.assign(new Error(body.error?.message || "供应链操作失败"), { code:body.error?.code || "SUPPLY_CHAIN_REQUEST_FAILED", status:response.status, details:body.error?.details || [] });
}

const refreshContent = () => {
  if (!location.hash.startsWith("#/supply-chain")) return;
  const container = document.querySelector("#page-content");
  if (container) container.innerHTML = renderSupplyChainPage();
};
const hydrate = async ({ force = false, announce = false } = {}) => {
  if (ui.loading || (ui.loaded && !force)) return ui.data;
  ui.loading = true;
  ui.error = "";
  refreshContent();
  try {
    ui.data = await request("/api/admin/supply-chain");
    ui.loaded = true;
    if (announce) toast("供应链数据已刷新", "success");
    return ui.data;
  } catch (error) {
    ui.loaded = false;
    ui.error = error.message;
    if (announce) toast(error.message, "danger");
    return null;
  } finally {
    ui.loading = false;
    refreshContent();
  }
};

const materialTable = () => {
  const materials = ui.data?.materials || [];
  if (!materials.length) return `<section class="card">${empty("暂无耗材主数据", "可先下载CSV模板，填写后导入耗材SKU、包装、MOQ、供应商和交期。")}</section>`;
  return `<section class="card"><div class="card-head"><div><div class="card-title">耗材主数据</div><div class="card-subtitle">共 ${materials.length} 个SKU</div></div><button class="btn small" data-action="supply-download-template" data-id="materials">${icon("download",14)}下载模板</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>SKU / 耗材</th><th>分类</th><th>单位 / 包装</th><th>MOQ / 交期</th><th>供应商</th><th>可用库存</th><th>批次</th><th>最近有效期</th></tr></thead><tbody>${materials.slice(0, 300).map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><div class="caption">${escapeHtml(item.sku)}</div></td><td>${escapeHtml(item.category)}</td><td>${escapeHtml(item.unit)}<div class="caption">${escapeHtml(item.package_spec || "未填写包装")}</div></td><td>${number(item.moq)}<div class="caption">${number(item.lead_time_days)} 天</div></td><td>${escapeHtml(item.supplier || "未填写")}</td><td><strong>${number(item.stock_available)}</strong><div class="caption">预留 ${number(item.stock_reserved)} · 隔离 ${number(item.stock_quarantine)}</div></td><td>${number(item.lot_count)}</td><td>${escapeHtml(item.nearest_expiry || "—")}<div>${badge(expiryLabel[item.expiry_status], expiryTone[item.expiry_status])}</div></td></tr>`).join("")}</tbody></table></div></section>`;
};

const inventoryTable = () => {
  const inventory = ui.data?.inventory || [];
  if (!inventory.length) return `<section class="card">${empty("暂无批次库存", "导入耗材主数据后，再导入仓库、库位、批次、有效期和数量。")}</section>`;
  return `<section class="card"><div class="card-head"><div><div class="card-title">批次库存与效期</div><div class="card-subtitle">共 ${inventory.length} 个批次；系统按有效期标记临期与过期</div></div><button class="btn small" data-action="supply-download-template" data-id="inventory">${icon("download",14)}下载模板</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>耗材</th><th>仓库 / 库位</th><th>批次</th><th>灭菌批次</th><th>有效期</th><th>可用</th><th>预留</th><th>隔离</th><th>状态</th></tr></thead><tbody>${inventory.slice(0, 500).map((item) => {
    const material = (ui.data?.materials || []).find((candidate) => candidate.sku === item.sku);
    return `<tr><td><strong>${escapeHtml(material?.name || item.sku)}</strong><div class="caption">${escapeHtml(item.sku)}</div></td><td>${escapeHtml(item.warehouse)}<div class="caption">${escapeHtml(item.location || "未填库位")}</div></td><td>${escapeHtml(item.batch_no)}</td><td>${escapeHtml(item.sterile_batch_no || "—")}</td><td>${escapeHtml(item.expiry_date)}</td><td><strong>${number(item.available_quantity)}</strong></td><td>${number(item.reserved_quantity)}</td><td>${number(item.quarantine_quantity)}</td><td>${badge(expiryLabel[item.expiry_status], expiryTone[item.expiry_status])}</td></tr>`;
  }).join("")}</tbody></table></div></section>`;
};

const futureCapabilities = () => `${card("需求预测与智能补货", `<div class="supply-chain-roadmap"><span>${icon("chart",20)}</span><div><strong>等待术式BOM和手术排程</strong><p>导入BOM、每日手术排程和实际消耗后，才能计算净需求、MOQ和采购建议。</p></div>${badge("下一阶段", "outline")}</div>`)}${card("耗材损耗分析", `<div class="supply-chain-roadmap"><span>${icon("alert",20)}</span><div><strong>等待实际领用与报废数据</strong><p>异常只作为待核查线索，不自动认定浪费或生成绩效结论。</p></div>${badge("下一阶段", "outline")}</div>`)}`;

export function renderSupplyChainPage() {
  if (!ui.loaded && !ui.loading) window.setTimeout(() => { void hydrate(); }, 0);
  const metrics = ui.data?.metrics || {};
  const content = !ui.loaded
    ? ui.error
      ? `<div class="risk-banner">${icon("alert",16)}<div><strong>供应链数据暂时无法读取</strong><br/>${escapeHtml(ui.error)}</div></div>`
      : `<section class="card">${empty(ui.loading ? "正在读取供应链数据" : "正在准备供应链模块", "将读取耗材主数据和批次库存。")}</section>`
    : `<div class="grid cols-5 supply-chain-metrics">${metric("耗材SKU", String(metrics.material_count || 0), "已导入主数据", "database")}${metric("库存批次", String(metrics.lot_count || 0), "按批次管理", "wallet")}${metric("可用库存", number(metrics.available_quantity), "当前批次合计", "chart")}${metric("90天临期", String(metrics.expiring_lot_count || 0), "需要关注", "clock")}${metric("已过期", String(metrics.expired_lot_count || 0), "禁止正常使用", "alert")}</div>
      ${materialTable()}${inventoryTable()}<div class="grid supply-chain-grid">${futureCapabilities()}</div>
      <div class="risk-banner">${icon("shield",16)}当前已实现CSV导入和效期预警；预测、补货建议和损耗分析会基于同一数据底座继续扩展。</div>`;
  const actions = `<button class="btn" data-action="supply-refresh">${icon("refresh",15)}刷新</button><button class="btn" data-action="supply-export" data-id="materials">${icon("download",15)}导出耗材</button><button class="btn" data-action="supply-export" data-id="inventory">${icon("download",15)}导出库存</button><button class="btn" data-action="supply-import" data-id="inventory">${icon("plus",15)}导入库存</button><button class="btn primary" data-action="supply-import" data-id="materials">${icon("plus",15)}导入耗材</button>`;
  return `<div class="page supply-chain-page">${pageHead("供应链治理", "供应链管理", "先导入耗材主数据和批次库存，建立可持续维护的数据底座。", actions)}<div class="supply-chain-body">${content}</div></div>`;
}

const downloadBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};
const downloadTemplate = (type) => {
  const content = type === "inventory"
    ? "sku,耗材名称,仓库,库位,批次号,灭菌批次号,有效期,可用数量,预留数量,隔离数量\r\nMAT-001,示例缝合线,主仓,A-01,BATCH-001,STERILE-001,2027-12-31,100,10,0\r\n"
    : "sku,耗材名称,分类,单位,包装规格,MOQ,供应商,交期天数\r\nMAT-001,示例缝合线,缝线,根,10根/盒,10,示例供应商,7\r\n";
  downloadBlob(new Blob([`\uFEFF${content}`], { type:"text/csv;charset=utf-8" }), type === "inventory" ? "库存导入模板.csv" : "耗材导入模板.csv");
};
const exportCsv = async (type) => {
  const response = await fetch(`/api/admin/supply-chain/export.csv?type=${encodeURIComponent(type)}`, { credentials:"same-origin", cache:"no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || "供应链数据导出失败");
  }
  const disposition = response.headers.get("Content-Disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  downloadBlob(await response.blob(), encoded ? decodeURIComponent(encoded) : `${type}.csv`);
};
const showImportModal = (type) => {
  openModal({
    title:type === "materials" ? "导入耗材主数据" : "导入批次库存",
    desc:"支持UTF-8 CSV，单次最多5000行、文件不超过2MB；存在任何错误时整批不写入。",
    wide:true,
    body:`<form id="supply-import-form" data-type="${type}">
      <label class="form-group"><span class="form-label">CSV文件</span><input class="form-control" name="file" type="file" accept=".csv,text/csv" required /></label>
      <div class="guardrail">${icon("shield",14)}${type === "materials" ? "至少包含：sku、耗材名称、单位。" : "至少包含：sku、仓库、批次号、有效期；SKU必须已导入主数据。"}</div>
    </form>`,
    footer:`<button class="btn" data-action="supply-download-template" data-id="${type}">下载模板</button><button class="btn" data-action="modal-close">取消</button><button class="btn primary" data-action="supply-submit-import" data-id="supply-import-form">开始导入</button>`
  });
};
const submitImport = async (form) => {
  const file = form.querySelector('[name="file"]')?.files?.[0];
  if (!file) throw new Error("请选择CSV文件");
  if (file.size > 2 * 1024 * 1024) throw new Error("CSV文件不能超过2MB");
  const type = form.dataset.type;
  const result = await request(`/api/admin/supply-chain/imports/${type === "inventory" ? "inventory" : "materials"}`, {
    method:"POST",
    headers:{ "Idempotency-Key":key(`supply-${type}`) },
    body:JSON.stringify({ file_name:file.name, csv_text:await file.text() })
  });
  closeModal();
  await hydrate({ force:true });
  toast(`导入完成：新增 ${result.created} 条，更新 ${result.updated} 条`, "success");
};

document.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-action]");
  if (!target || !String(target.dataset.action || "").startsWith("supply-")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (target.dataset.action === "supply-refresh") void hydrate({ force:true, announce:true });
  if (target.dataset.action === "supply-import") showImportModal(target.dataset.id || "materials");
  if (target.dataset.action === "supply-download-template") downloadTemplate(target.dataset.id || "materials");
  if (target.dataset.action === "supply-export") void exportCsv(target.dataset.id || "materials").catch((error) => toast(error.message, "danger"));
  if (target.dataset.action === "supply-submit-import") {
    const form = document.getElementById(target.dataset.id);
    if (form) form.requestSubmit();
  }
}, true);

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id !== "supply-import-form") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (form.dataset.submitting === "true") return;
  form.dataset.submitting = "true";
  try {
    await submitImport(form);
  } catch (error) {
    const details = Array.isArray(error.details) && error.details.length
      ? `：${error.details.slice(0, 5).map((item) => `第${item.line || "?"}行 ${item.message || item.sku || ""}`).join("；")}`
      : "";
    toast(`${error.message}${details}`, "danger");
  } finally {
    form.dataset.submitting = "false";
  }
});
