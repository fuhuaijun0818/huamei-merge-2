import assert from "node:assert/strict";

process.env.HUAMEI_SUPPLY_CHAIN_STORE_FILE = ":memory:";
const supply = await import("../server/supply-chain-operations.mjs");

const tenantId = "tenant-supply-chain-test";
const actor = "supply-chain-test";
const dateAfter = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

const materialResult = await supply.importSupplyChainCsv({
  tenantId,
  actor,
  type:"materials",
  payload:{
    file_name:"耗材主数据.csv",
    csv_text:"\uFEFFsku,耗材名称,分类,单位,包装规格,MOQ,供应商,交期天数\r\nMAT-001,缝合线,缝线,根,10根/盒,10,测试供应商,7\r\nMAT-002,\"一次性刀片,无菌\",器械,片,1片/包,20,第二供应商,14\r\n"
  }
});
assert.equal(materialResult.created, 2);
assert.equal(materialResult.updated, 0);

const inventoryResult = await supply.importSupplyChainCsv({
  tenantId,
  actor,
  type:"inventory",
  payload:{
    file_name:"库存.csv",
    csv_text:`sku,耗材名称,仓库,库位,批次号,灭菌批次号,有效期,可用数量,预留数量,隔离数量\r\nMAT-001,缝合线,主仓,A-01,BATCH-001,STERILE-001,${dateAfter(30)},100,10,2\r\nMAT-001,缝合线,主仓,A-02,BATCH-002,STERILE-002,${dateAfter(365)},50,5,0\r\nMAT-002,一次性刀片,主仓,B-01,BATCH-003,,${dateAfter(-10)},20,0,20\r\n`
  }
});
assert.equal(inventoryResult.created, 3);

const overview = await supply.getSupplyChainOverview({ tenantId });
assert.equal(overview.metrics.material_count, 2);
assert.equal(overview.metrics.lot_count, 3);
assert.equal(overview.metrics.available_quantity, 150, "expired batches must not count as usable stock");
assert.equal(overview.metrics.expired_available_quantity, 20);
assert.equal(overview.metrics.expiring_lot_count, 1);
assert.equal(overview.metrics.expired_lot_count, 1);
assert.equal(overview.materials.find((item) => item.sku === "MAT-001").stock_available, 150);
assert.equal(overview.materials.find((item) => item.sku === "MAT-002").expiry_status, "expired");

const updateResult = await supply.importSupplyChainCsv({
  tenantId,
  actor,
  type:"materials",
  payload:{
    file_name:"耗材更新.csv",
    csv_text:"sku,耗材名称,分类,单位,包装规格,MOQ,供应商,交期天数\r\nMAT-001,不可吸收缝合线,缝线,根,10根/盒,12,更新供应商,5\r\n"
  }
});
assert.equal(updateResult.created, 0);
assert.equal(updateResult.updated, 1);
const updated = await supply.getSupplyChainOverview({ tenantId });
assert.equal(updated.materials.find((item) => item.sku === "MAT-001").name, "不可吸收缝合线");
assert.equal(updated.materials.find((item) => item.sku === "MAT-001").moq, 12);
assert.equal(updated.materials.find((item) => item.sku === "MAT-001").stock_available, 150);

await assert.rejects(
  supply.importSupplyChainCsv({
    tenantId,
    actor,
    type:"inventory",
    payload:{
      file_name:"错误库存.csv",
      csv_text:`sku,耗材名称,仓库,库位,批次号,灭菌批次号,有效期,可用数量,预留数量,隔离数量\r\nMAT-999,不存在,主仓,C-01,BATCH-999,,${dateAfter(90)},1,0,0\r\n`
    }
  }),
  (error) => error.code === "SUPPLY_CHAIN_MATERIAL_NOT_FOUND" && error.details[0].sku === "MAT-999"
);
const afterFailure = await supply.getSupplyChainOverview({ tenantId });
assert.equal(afterFailure.metrics.lot_count, 3, "failed inventory imports must be atomic");

const materialsCsv = await supply.exportSupplyChainCsv({ tenantId, type:"materials" });
const inventoryCsv = await supply.exportSupplyChainCsv({ tenantId, type:"inventory" });
assert.match(materialsCsv.file_name, /^耗材主数据_\d{4}-\d{2}-\d{2}\.csv$/);
assert.match(inventoryCsv.file_name, /^库存批次_\d{4}-\d{2}-\d{2}\.csv$/);
assert.match(materialsCsv.buffer.toString("utf8"), /不可吸收缝合线/);
assert.match(inventoryCsv.buffer.toString("utf8"), /BATCH-001/);

await supply.importSupplyChainCsv({
  tenantId,
  actor,
  type:"materials",
  payload:{
    file_name:"补货耗材.csv",
    csv_text:"sku,耗材名称,分类,单位,包装规格,MOQ,供应商,交期天数\r\nMAT-003,可吸收缝合线,缝线,根,5根/盒,12,第三供应商,3\r\n"
  }
});
await supply.importSupplyChainCsv({
  tenantId,
  actor,
  type:"inventory",
  payload:{
    file_name:"补货库存.csv",
    csv_text:`sku,耗材名称,仓库,库位,批次号,灭菌批次号,有效期,可用数量,预留数量,隔离数量\r\nMAT-003,可吸收缝合线,主仓,D-01,BATCH-004,,${dateAfter(180)},5,0,0\r\n`
  }
});

const bomV1 = await supply.importSupplyChainCsv({
  tenantId,
  actor,
  type:"bom",
  payload:{
    file_name:"术式BOM-v1.csv",
    csv_text:"procedure_code,procedure_name,sku,standard_quantity,version\r\nPROC-A,术式A,MAT-001,2,1\r\nPROC-A,术式A,MAT-002,1,1\r\nPROC-B,术式B,MAT-001,5,1\r\nPROC-C,术式C,MAT-003,4,1\r\n"
  }
});
assert.deepEqual({ created:bomV1.created, updated:bomV1.updated }, { created:4, updated:0 });
const bomV2 = await supply.importSupplyChainCsv({
  tenantId,
  actor,
  type:"bom",
  payload:{
    file_name:"术式BOM-v2.csv",
    csv_text:"procedure_code,procedure_name,sku,standard_quantity,version\r\nPROC-C,术式C,MAT-003,6,2\r\n"
  }
});
assert.deepEqual({ created:bomV2.created, updated:bomV2.updated }, { created:1, updated:0 });

const surgeryResult = await supply.importSupplyChainCsv({
  tenantId,
  actor,
  type:"surgeries",
  payload:{
    file_name:"手术排程.csv",
    csv_text:`surgery_id,surgery_date,procedure_code,procedure_name,doctor,department,status,complexity\r\nSURG-P1,${dateAfter(10)},PROC-A,术式A,张医生,整形外科,planned,standard\r\nSURG-P2,${dateAfter(12)},PROC-A,术式A,张医生,整形外科,planned,complex\r\nSURG-P3,${dateAfter(15)},PROC-B,术式B,赵医生,整形外科,planned,standard\r\nSURG-P4,${dateAfter(20)},PROC-C,术式C,周医生,皮肤科,planned,standard\r\nSURG-P5,${dateAfter(21)},PROC-C,术式C,周医生,皮肤科,planned,standard\r\nSURG-P6,${dateAfter(22)},PROC-C,术式C,周医生,皮肤科,planned,standard\r\nSURG-MISSING,${dateAfter(25)},PROC-UNKNOWN,未配置术式,钱医生,整形外科,planned,standard\r\nSURG-H1,${dateAfter(-3)},PROC-A,术式A,李医生,整形外科,completed,standard\r\nSURG-H2,${dateAfter(-2)},PROC-A,术式A,李医生,整形外科,completed,standard\r\n`
  }
});
assert.equal(surgeryResult.created, 9);

await assert.rejects(
  supply.importSupplyChainCsv({
    tenantId,
    actor,
    type:"consumption",
    payload:{
      file_name:"未知手术消耗.csv",
      csv_text:"surgery_id,sku,actual_consumed_quantity,used_quantity,returned_quantity,wasted_quantity\r\nSURG-H1,MAT-001,9,9,0,0\r\nSURG-NOT-FOUND,MAT-001,1,1,0,0\r\n"
    }
  }),
  (error) => error.code === "SUPPLY_CHAIN_SURGERY_NOT_FOUND" && error.details[0].surgery_id === "SURG-NOT-FOUND"
);
await assert.rejects(
  supply.importSupplyChainCsv({
    tenantId,
    actor,
    type:"consumption",
    payload:{
      file_name:"未知SKU消耗.csv",
      csv_text:"surgery_id,sku,actual_consumed_quantity,used_quantity,returned_quantity,wasted_quantity\r\nSURG-H1,MAT-001,9,9,0,0\r\nSURG-H2,MAT-999,1,1,0,0\r\n"
    }
  }),
  (error) => error.code === "SUPPLY_CHAIN_MATERIAL_NOT_FOUND" && error.details[0].sku === "MAT-999"
);
const consumptionResult = await supply.importSupplyChainCsv({
  tenantId,
  actor,
  type:"consumption",
  payload:{
    file_name:"实际消耗.csv",
    csv_text:"surgery_id,sku,actual_consumed_quantity,used_quantity,returned_quantity,wasted_quantity\r\nSURG-H1,MAT-001,3,3,0,0.5\r\nSURG-H2,MAT-001,3,3,0,0.5\r\n"
  }
});
assert.equal(consumptionResult.created, 2);

const transitResult = await supply.importSupplyChainCsv({
  tenantId,
  actor,
  type:"in-transit",
  payload:{
    file_name:"在途采购.csv",
    csv_text:`sku,po_number,quantity,expected_date,supplier\r\nMAT-003,PO-FUTURE,2,${dateAfter(5)},第三供应商\r\nMAT-002,PO-OVERDUE,100,${dateAfter(-2)},第二供应商\r\n`
  }
});
assert.equal(transitResult.created, 2);

const planningOverview = await supply.getSupplyChainOverview({ tenantId });
assert.equal(planningOverview.metrics.bom_count, 4, "only the latest BOM version per procedure and SKU should be active");
assert.equal(planningOverview.metrics.planned_surgery_count, 7);
assert.equal(planningOverview.metrics.recommendation_count, 2);
assert.equal(planningOverview.metrics.anomaly_count, 1);
assert.equal(planningOverview.procedure_boms.find((item) => item.procedure_code === "PROC-C" && item.sku === "MAT-003").version, 2);
assert.equal(planningOverview.surgeries.length, 7);
assert.deepEqual(planningOverview.bom_warnings.map((item) => item.surgery_id), ["SURG-MISSING"]);

const mat001Recommendation = planningOverview.purchase_recommendations.find((item) => item.sku === "MAT-001");
assert.deepEqual(
  {
    demand:mat001Recommendation.demand_quantity,
    available:mat001Recommendation.available_quantity,
    incoming:mat001Recommendation.incoming_quantity,
    net:mat001Recommendation.net_requirement,
    recommended:mat001Recommendation.recommended_quantity
  },
  { demand:9, available:150, incoming:0, net:0, recommended:0 }
);
const mat002Recommendation = planningOverview.purchase_recommendations.find((item) => item.sku === "MAT-002");
assert.deepEqual(
  {
    demand:mat002Recommendation.demand_quantity,
    available:mat002Recommendation.available_quantity,
    incoming:mat002Recommendation.incoming_quantity,
    net:mat002Recommendation.net_requirement,
    recommended:mat002Recommendation.recommended_quantity
  },
  { demand:2, available:0, incoming:0, net:2, recommended:20 },
  "expired inventory and overdue purchase orders must not satisfy future demand"
);
const mat003Recommendation = planningOverview.purchase_recommendations.find((item) => item.sku === "MAT-003");
assert.deepEqual(
  {
    demand:mat003Recommendation.demand_quantity,
    available:mat003Recommendation.available_quantity,
    incoming:mat003Recommendation.incoming_quantity,
    net:mat003Recommendation.net_requirement,
    recommended:mat003Recommendation.recommended_quantity
  },
  { demand:18, available:5, incoming:2, net:11, recommended:12 },
  "recommendations must include future in-transit stock and round up to MOQ"
);

const anomaly = planningOverview.anomaly_reviews[0];
assert.deepEqual(
  {
    doctor:anomaly.doctor,
    department:anomaly.department,
    procedure:anomaly.procedure_code,
    sku:anomaly.sku,
    cases:anomaly.case_count,
    expected:anomaly.expected_quantity,
    actual:anomaly.actual_quantity,
    wasted:anomaly.wasted_quantity,
    ratio:anomaly.ratio
  },
  {
    doctor:"李医生",
    department:"整形外科",
    procedure:"PROC-A",
    sku:"MAT-001",
    cases:2,
    expected:4,
    actual:6,
    wasted:1,
    ratio:1.5
  }
);

console.log("supply-chain-operations: passed");
