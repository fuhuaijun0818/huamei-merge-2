import { icon } from "../../icons.js";
import { badge, card, closeModal, empty, escapeHtml, formatDate, metric, openModal, pageHead, toast } from "../../ui.js";

const ui = { loaded:false, loading:false, error:"", data:null };
const key = (prefix) => `${prefix}-${crypto.randomUUID()}`.slice(0, 128);
const number = (value) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits:3 }).format(Number(value) || 0);
const expiryLabel = { expired:"已过期", expiring:"90天内到期", normal:"正常", no_stock:"无库存" };
const expiryTone = { expired:"danger", expiring:"warning", normal:"success", no_stock:"outline" };
const importMeta = Object.freeze({
  materials:{ title:"耗材主数据", description:"耗材SKU、名称、单位、包装、MOQ、供应商和交期" },
  inventory:{ title:"批次库存", description:"SKU、仓库、批次、有效期和可用/预留/隔离数量" },
  bom:{ title:"术式BOM", description:"术式编码、术式名称、SKU、标准用量和版本" },
  surgeries:{ title:"手术排程", description:"手术编号、日期、术式、医生、科室和状态" },
  consumption:{ title:"实际消耗", description:"手术编号、SKU、实际消耗、领用、退回和报废数量" },
  "in-transit":{ title:"在途采购", description:"采购单号、SKU、在途数量和预计到货日期" }
});
const reviewDecisionLabel = Object.freeze({ accepted:"核查后无异常", follow_up:"需要后续跟进" });

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

const bomTable = () => {
  const items = ui.data?.procedure_boms || [];
  if (!items.length) return card("术式BOM", `<div class="supply-chain-roadmap"><span>${icon("database",20)}</span><div><strong>尚未配置术式BOM</strong><p>导入每个术式的耗材标准用量后，手术排程才能转换为计划需求。</p></div>${badge("待导入", "outline")}</div>`);
  return card("术式BOM", `<div class="table-wrap"><table class="data-table"><thead><tr><th>术式</th><th>耗材</th><th>标准用量</th><th>版本</th></tr></thead><tbody>${items.slice(0, 200).map((item) => `<tr><td><strong>${escapeHtml(item.procedure_name)}</strong><div class="caption">${escapeHtml(item.procedure_code)}</div></td><td>${escapeHtml(item.sku)}</td><td>${number(item.standard_quantity)}</td><td>v${number(item.version)}</td></tr>`).join("")}</tbody></table></div>`);
};
const scheduleTable = () => {
  const items = ui.data?.surgeries || [];
  if (!items.length) return card("未来手术排程", `<div class="supply-chain-roadmap"><span>${icon("calendar",20)}</span><div><strong>尚未导入手术排程</strong><p>导入未来已排手术后，系统才能按术式BOM计算30天需求。</p></div>${badge("待导入", "outline")}</div>`);
  return card("未来手术排程", `<div class="table-wrap"><table class="data-table"><thead><tr><th>日期</th><th>术式</th><th>医生 / 科室</th><th>复杂度</th><th>状态</th></tr></thead><tbody>${items.slice(0, 200).map((item) => `<tr><td>${escapeHtml(item.surgery_date)}</td><td><strong>${escapeHtml(item.procedure_name || item.procedure_code)}</strong><div class="caption">${escapeHtml(item.surgery_id)}</div></td><td>${escapeHtml(item.doctor)}<div class="caption">${escapeHtml(item.department)}</div></td><td>${escapeHtml(item.complexity || "standard")}</td><td>${badge(item.status === "planned" ? "已排期" : item.status === "completed" ? "已完成" : "已取消", item.status === "planned" ? "warning" : item.status === "completed" ? "success" : "outline")}</td></tr>`).join("")}</tbody></table></div>`);
};
const recommendationTable = () => {
  const items = ui.data?.purchase_recommendations || [];
  const warnings = ui.data?.bom_warnings || [];
  const warningList = warnings.length ? `<div class="supply-chain-warnings">${warnings.slice(0, 10).map((item) => `<div>${icon("alert",14)}<span>${escapeHtml(item.procedure_code)} · ${escapeHtml(item.message)}<small>手术编号：${escapeHtml(item.surgery_id)}</small></span></div>`).join("")}</div>` : "";
  return card("30天需求与补货建议", items.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>耗材</th><th>计划需求</th><th>可用库存</th><th>预计在途</th><th>净需求</th><th>MOQ</th><th>建议采购</th></tr></thead><tbody>${items.slice(0, 200).map((item) => `<tr><td><strong>${escapeHtml(item.material_name)}</strong><div class="caption">${escapeHtml(item.sku)}</div></td><td>${number(item.demand_quantity)}</td><td>${number(item.available_quantity)}</td><td>${number(item.incoming_quantity)}</td><td>${number(item.net_requirement)}</td><td>${number(item.moq)}</td><td><strong>${number(item.recommended_quantity)}</strong><div class="caption">${escapeHtml(item.supplier || "未配置供应商")} · ${number(item.lead_time_days)}天交期</div></td></tr>`).join("")}</tbody></table></div>${warningList}`
    : `<div class="supply-chain-roadmap"><span>${icon("chart",20)}</span><div><strong>尚无可计算的需求</strong><p>需要先导入耗材、库存、术式BOM和未来手术排程；安全库存暂按0计算。</p></div>${badge("待数据", "outline")}</div>${warningList}`, { className:"supply-chain-recommendations" });
};
const anomalyTable = () => {
  const items = ui.data?.anomaly_reviews || [];
  const reviewedItems = ui.data?.reviewed_anomaly_reviews || [];
  const reviewedCount = Number(ui.data?.metrics?.reviewed_anomaly_count || 0);
  const reviewedSummary = reviewedItems.length ? `<div class="supply-anomaly-reviewed">
    <div class="supply-anomaly-reviewed-head">${icon("check",15)}<strong>已登记复核 ${number(reviewedCount)} 项</strong><span>最近记录</span></div>
    ${reviewedItems.slice(0, 4).map((item) => `<div class="supply-anomaly-reviewed-row">
      <span>${badge(reviewDecisionLabel[item.review?.decision] || "已复核", item.review?.decision === "follow_up" ? "warning" : "success")}<strong>${escapeHtml(item.doctor)} · ${escapeHtml(item.material_name)}</strong></span>
      <small>${escapeHtml(item.review?.note || "")} · ${escapeHtml(item.review?.actor || "")} · ${escapeHtml(formatDate(item.review?.reviewed_at))}</small>
    </div>`).join("")}
  </div>` : "";
  if (!items.length) return card("耗材损耗异常复核", `<div class="supply-chain-roadmap"><span>${icon(reviewedCount ? "check" : "alert",20)}</span><div><strong>${reviewedCount ? "暂无待复核异常" : "暂无可复核异常"}</strong><p>${reviewedCount ? `已有 ${number(reviewedCount)} 项完成复核登记；如病例或BOM数据变化，系统会重新生成待复核项。` : "需要至少两个已完成同术式病例及实际消耗记录；异常仅作人工复核线索。"}</p></div>${badge(reviewedCount ? "已处理" : "待数据", reviewedCount ? "success" : "outline")}</div>${reviewedSummary}`, { className:"supply-chain-anomalies", subtitle:"按医生、科室、术式和耗材聚合已完成病例", action:badge("0项待核查", "success") });
  const visible = items.slice(0, 24);
  const maxDeviation = Math.round(Math.max(...items.map((item) => (Number(item.ratio) || 1) - 1)) * 100);
  const affectedDoctors = new Set(items.map((item) => item.doctor)).size;
  const affectedMaterials = new Set(items.map((item) => item.sku)).size;
  const affectedCases = items.reduce((sum, item) => sum + Number(item.case_count || 0), 0);
  const cards = visible.map((item) => {
    const actual = Math.max(0, Number(item.actual_quantity) || 0);
    const expected = Math.max(0, Number(item.expected_quantity) || 0);
    const wasted = Math.max(0, Number(item.wasted_quantity) || 0);
    const ratio = Math.max(0, Number(item.ratio) || 0);
    const scale = Math.max(actual, expected, 1);
    const actualWidth = Math.min(100, actual / scale * 100);
    const expectedWidth = Math.min(100, expected / scale * 100);
    const deviation = Math.round((ratio - 1) * 100);
    const excess = Math.max(0, actual - expected);
    const doctorName = String(item.doctor || "未知医生").trim();
    const procedureName = item.procedure_name || item.procedure_code;
    return `<article class="supply-anomaly-card" data-anomaly-review>
      <div class="supply-anomaly-card-head">
        <div class="supply-anomaly-person">
          <span class="supply-anomaly-avatar">${escapeHtml(doctorName.slice(0, 1) || "医")}</span>
          <div><strong>${escapeHtml(doctorName)}</strong><small>${escapeHtml(item.department || "未填科室")}</small></div>
        </div>
        <span class="supply-anomaly-delta">+${number(deviation)}%</span>
      </div>
      <div class="supply-anomaly-context">
        <span>${icon("medical",13)}${escapeHtml(procedureName)}</span>
        <span>${icon("database",13)}${escapeHtml(item.material_name)}</span>
      </div>
      <div class="supply-anomaly-compare" aria-label="${escapeHtml(`${doctorName}的${procedureName}：实际消耗${number(actual)}，BOM标准${number(expected)}`)}">
        <div><span>实际</span><div class="supply-anomaly-track"><i class="actual" style="width:${actualWidth}%"></i></div><strong>${number(actual)}</strong></div>
        <div><span>标准</span><div class="supply-anomaly-track"><i class="standard" style="width:${expectedWidth}%"></i></div><strong>${number(expected)}</strong></div>
      </div>
      <div class="supply-anomaly-facts">
        <span><small>可比病例</small><strong>${number(item.case_count)}</strong></span>
        <span><small>超出标准</small><strong>${number(excess)}</strong></span>
        <span><small>记录报废</small><strong>${number(wasted)}</strong></span>
      </div>
      <div class="supply-anomaly-footer">
        <div class="supply-anomaly-note">${icon("shield",14)}<span>${escapeHtml(item.note || "请人工复核本次消耗差异。")}</span></div>
        <button class="btn small primary" data-action="supply-review-anomaly" data-id="${escapeHtml(item.anomaly_id)}">${icon("check",14)}登记复核</button>
      </div>
    </article>`;
  }).join("");
  const more = items.length > visible.length
    ? `<div class="supply-anomaly-more">当前展示偏差最高的 ${visible.length} 项，共 ${items.length} 项待人工复核。</div>`
    : "";
  return card("耗材损耗异常复核", `
    <div class="supply-anomaly-overview">
      <div class="supply-anomaly-overview-lead">
        <span>${icon("alert",18)}</span>
        <div><strong>${number(items.length)} 项需要人工复核</strong><small>异常是核查线索，不自动认定浪费或形成绩效结论。</small></div>
      </div>
      <div class="supply-anomaly-stat"><span>最高偏差</span><strong>+${number(maxDeviation)}%</strong></div>
      <div class="supply-anomaly-stat"><span>涉及病例</span><strong>${number(affectedCases)}</strong></div>
      <div class="supply-anomaly-stat"><span>医生 / 耗材</span><strong>${number(affectedDoctors)} / ${number(affectedMaterials)}</strong></div>
      <div class="supply-anomaly-stat"><span>已复核</span><strong>${number(reviewedCount)}</strong></div>
    </div>
    <div class="supply-anomaly-legend">
      <span><i class="actual"></i>实际消耗</span>
      <span><i class="standard"></i>BOM 标准</span>
      <small>对比条按同一病例组最大用量缩放</small>
    </div>
    <div class="supply-anomaly-list">${cards}</div>
    ${more}
    ${reviewedSummary}
  `, { subtitle:"按医生、科室、术式和耗材聚合已完成病例", className:"supply-chain-anomalies", action:badge(`${items.length}项待核查`, "warning") });
};

export function renderSupplyChainPage() {
  if (!ui.loaded && !ui.loading) window.setTimeout(() => { void hydrate(); }, 0);
  const metrics = ui.data?.metrics || {};
  const content = !ui.loaded
    ? ui.error
      ? `<div class="risk-banner">${icon("alert",16)}<div><strong>供应链数据暂时无法读取</strong><br/>${escapeHtml(ui.error)}</div></div>`
      : `<section class="card">${empty(ui.loading ? "正在读取供应链数据" : "正在准备供应链模块", "将读取耗材、库存、手术排程、补货建议和异常复核数据。")}</section>`
    : `<div class="grid cols-4 supply-chain-metrics">${metric("耗材SKU", String(metrics.material_count || 0), "已导入主数据", "database")}${metric("库存批次", String(metrics.lot_count || 0), "按批次管理", "wallet")}${metric("未来30天手术", String(metrics.planned_surgery_count || 0), "已排期病例", "calendar")}${metric("建议补货SKU", String(metrics.recommendation_count || 0), "按BOM与在途计算", "clock")}${metric("可用库存", number(metrics.available_quantity), "排除过期批次", "chart")}${metric("90天临期", String(metrics.expiring_lot_count || 0), "需要关注", "clock")}${metric("已过期", String(metrics.expired_lot_count || 0), "禁止正常使用", "alert")}${metric("异常待复核", String(metrics.anomaly_count || 0), "不自动认定浪费", "alert")}</div>
      <section class="card padded"><div class="card-head"><div><div class="card-title">数据导入</div><div class="card-subtitle">按顺序导入：耗材 → 库存 → 术式BOM → 手术排程 → 实际消耗/在途采购</div></div></div><div class="supply-import-actions">${Object.entries(importMeta).map(([type, meta]) => `<button class="btn" data-action="supply-import" data-id="${type}">${icon("plus",14)}${meta.title}</button>`).join("")}</div></section>
      ${materialTable()}${inventoryTable()}${bomTable()}${scheduleTable()}<div class="grid supply-chain-grid">${recommendationTable()}${anomalyTable()}</div>
      <div class="risk-banner">${icon("shield",16)}补货建议使用已排手术、最新BOM、可用库存、预计在途和MOQ计算，安全库存暂按0；所有采购建议和异常均需人工确认。</div>`;
  const actions = `<button class="btn" data-action="supply-refresh">${icon("refresh",15)}刷新</button><button class="btn" data-action="supply-export" data-id="materials">${icon("download",15)}导出耗材</button><button class="btn" data-action="supply-export" data-id="inventory">${icon("download",15)}导出库存</button>`;
  return `<div class="page supply-chain-page">${pageHead("供应链治理", "供应链管理", "由手术排程与术式BOM推导耗材需求，再结合库存、在途和MOQ形成人工复核建议。", actions)}<div class="supply-chain-body">${content}</div></div>`;
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
  const templates = {
    materials:"sku,耗材名称,分类,单位,包装规格,MOQ,供应商,交期天数\r\nMAT-001,示例缝合线,缝线,根,10根/盒,10,示例供应商,7\r\n",
    inventory:"sku,耗材名称,仓库,库位,批次号,灭菌批次号,有效期,可用数量,预留数量,隔离数量\r\nMAT-001,示例缝合线,主仓,A-01,BATCH-001,STERILE-001,2027-12-31,100,10,0\r\n",
    bom:"procedure_code,procedure_name,sku,standard_quantity,version\r\nPROC-001,示例术式,MAT-001,2,1\r\n",
    surgeries:"surgery_id,surgery_date,procedure_code,procedure_name,doctor,department,status,complexity\r\nSURG-001,2027-01-15,PROC-001,示例术式,张医生,整形外科,planned,standard\r\n",
    consumption:"surgery_id,sku,actual_consumed_quantity,used_quantity,returned_quantity,wasted_quantity\r\nSURG-001,MAT-001,2,3,1,0\r\n",
    "in-transit":"sku,po_number,quantity,expected_date,supplier\r\nMAT-001,PO-001,20,2027-01-10,示例供应商\r\n"
  };
  downloadBlob(new Blob([`\uFEFF${templates[type]}`], { type:"text/csv;charset=utf-8" }), `${importMeta[type].title}导入模板.csv`);
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
  const meta = importMeta[type];
  openModal({
    title:`导入${meta.title}`,
    desc:"支持UTF-8 CSV，单次最多5000行、文件不超过2MB；存在任何错误时整批不写入。",
    wide:true,
    body:`<form id="supply-import-form" data-type="${type}">
      <label class="form-group"><span class="form-label">CSV文件</span><input class="form-control" name="file" type="file" accept=".csv,text/csv" required /></label>
      <div class="guardrail">${icon("shield",14)}${meta.description}。请先下载模板，确保字段和格式正确。</div>
    </form>`,
    footer:`<button class="btn" data-action="supply-download-template" data-id="${type}">下载模板</button><button class="btn" data-action="modal-close">取消</button><button class="btn primary" data-action="supply-submit-import" data-id="supply-import-form">开始导入</button>`
  });
};
const submitImport = async (form) => {
  const file = form.querySelector('[name="file"]')?.files?.[0];
  if (!file) throw new Error("请选择CSV文件");
  if (file.size > 2 * 1024 * 1024) throw new Error("CSV文件不能超过2MB");
  const type = form.dataset.type;
  const result = await request(`/api/admin/supply-chain/imports/${type}`, {
    method:"POST",
    headers:{ "Idempotency-Key":key(`supply-${type}`) },
    body:JSON.stringify({ file_name:file.name, csv_text:await file.text() })
  });
  closeModal();
  await hydrate({ force:true });
  toast(`导入完成：新增 ${result.created} 条，更新 ${result.updated} 条`, "success");
};
const showAnomalyReviewModal = (anomalyId) => {
  const item = (ui.data?.anomaly_reviews || []).find((candidate) => candidate.anomaly_id === anomalyId);
  if (!item) {
    toast("异常项已变化，请刷新后重试", "danger");
    return;
  }
  openModal({
    title:"登记异常复核结论",
    desc:"复核不会修改原始消耗数据；系统将保存当前病例快照、复核人、时间和说明。",
    wide:true,
    body:`<form id="supply-anomaly-review-form">
      <input type="hidden" name="anomaly_id" value="${escapeHtml(item.anomaly_id)}" />
      <div class="supply-anomaly-review-context">
        <div><span>复核对象</span><strong>${escapeHtml(item.doctor)} · ${escapeHtml(item.department || "未填科室")}</strong></div>
        <div><span>术式 / 耗材</span><strong>${escapeHtml(item.procedure_name || item.procedure_code)} · ${escapeHtml(item.material_name)}</strong></div>
        <div><span>实际 / 标准</span><strong>${number(item.actual_quantity)} / ${number(item.expected_quantity)}</strong></div>
        <div><span>可比病例</span><strong>${number(item.case_count)} 例</strong></div>
      </div>
      <label class="form-group"><span class="form-label">复核结论</span><select class="form-control" name="decision" required><option value="accepted">${reviewDecisionLabel.accepted}，完成本次复核</option><option value="follow_up">${reviewDecisionLabel.follow_up}，登记跟进事项</option></select></label>
      <label class="form-group"><span class="form-label">复核说明（至少2个字符）</span><textarea class="form-control" name="note" minlength="2" maxlength="300" required placeholder="填写核查依据、差异原因或后续处理安排"></textarea></label>
      <div class="guardrail">${icon("shield",14)}该结论仅用于供应链人工复核审计，不会自动认定浪费、处罚或个人绩效。</div>
    </form>`,
    footer:`<button class="btn" data-action="modal-close">取消</button><button class="btn primary" data-action="supply-submit-anomaly-review" data-id="supply-anomaly-review-form">${icon("check",14)}保存复核结论</button>`
  });
};
const submitAnomalyReview = async (form) => {
  const formData = new FormData(form);
  const result = await request("/api/admin/supply-chain/anomaly-reviews", {
    method:"POST",
    headers:{ "Idempotency-Key":key("supply-anomaly-review") },
    body:JSON.stringify({
      anomaly_id:formData.get("anomaly_id"),
      decision:formData.get("decision"),
      note:formData.get("note")
    })
  });
  closeModal();
  await hydrate({ force:true });
  toast(`复核已登记：${reviewDecisionLabel[result.decision] || "已处理"}`, result.decision === "follow_up" ? "warning" : "success");
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
  if (target.dataset.action === "supply-review-anomaly") showAnomalyReviewModal(target.dataset.id || "");
  if (target.dataset.action === "supply-submit-import") {
    const form = document.getElementById(target.dataset.id);
    if (form) form.requestSubmit();
  }
  if (target.dataset.action === "supply-submit-anomaly-review") {
    const form = document.getElementById(target.dataset.id);
    if (form) form.requestSubmit();
  }
}, true);

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!["supply-import-form", "supply-anomaly-review-form"].includes(form.id)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (form.dataset.submitting === "true") return;
  form.dataset.submitting = "true";
  try {
    if (form.id === "supply-import-form") await submitImport(form);
    else await submitAnomalyReview(form);
  } catch (error) {
    const details = Array.isArray(error.details) && error.details.length
      ? `：${error.details.slice(0, 5).map((item) => `第${item.line || "?"}行 ${item.message || item.sku || ""}`).join("；")}`
      : "";
    toast(`${error.message}${details}`, "danger");
  } finally {
    form.dataset.submitting = "false";
  }
});
