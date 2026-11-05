import { icon } from "../../icons.js";
import { badge, card, metric, pageHead } from "../../ui.js";

const prerequisites = [
  ["耗材主数据", "统一SKU、规格、供应商、包装、MOQ与交期"],
  ["批次库存", "在库、预留、可用、批次、效期、库位与在途"],
  ["手术排程", "手术日期、术式、医生、科室与取消改期状态"],
  ["术式BOM", "每个术式的标准耗材、用量与版本"],
  ["实际消耗", "领用、使用、退库、报废与计费套包"]
];

export function renderSupplyChainPage() {
  return `<div class="page supply-chain-page">${pageHead("供应链治理", "供应链管理", "供应链账号已开通；真实预测与补货需先接入库存、手术排程和实际消耗数据。", `<span class="supply-chain-status">${badge("数据接入准备中", "warning")}</span>`)}
    <div class="grid cols-4 supply-chain-metrics">${metric("耗材SKU", "—", "等待耗材主数据", "database")}${metric("库存批次", "—", "等待仓库流水", "wallet")}${metric("待补货", "—", "未接入规则计算", "clock")}${metric("异常复核", "—", "未接入损耗数据", "alert")}</div>
    <div class="grid supply-chain-grid">
      ${card("需求预测与智能补货", `<div class="supply-chain-roadmap"><span>${icon("chart",20)}</span><div><strong>按手术排程计算计划需求</strong><p>接入已排手术和术式BOM后，计算预计耗材需求、安全库存、在途和MOQ，生成可解释的采购建议。</p></div>${badge("待数据接入", "outline")}</div>`)}
      ${card("耗材损耗分析", `<div class="supply-chain-roadmap"><span>${icon("alert",20)}</span><div><strong>按医生、项目、科室复核异常</strong><p>仅对同术式和可比较病例生成待核查线索，不自动认定浪费、不直接生成绩效结论。</p></div>${badge("待消耗数据", "outline")}</div>`)}
    </div>
    <section class="card padded"><div class="card-head"><div><div class="card-title">上线前置数据</div><div class="card-subtitle">当前没有用虚构数据代替真实库存和补货结果</div></div></div><div class="supply-chain-prerequisites">${prerequisites.map(([title, detail], index) => `<div><span>${index + 1}</span><div><strong>${title}</strong><small>${detail}</small></div>${badge("待接入", "outline")}</div>`).join("")}</div></section>
    <div class="risk-banner">${icon("shield",16)}供应链管理员不具备客户、会话、知识发布、财务审批或系统管理权限。采购建议必须经人工确认，不能自动下单。</div>
  </div>`;
}
