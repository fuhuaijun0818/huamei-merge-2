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

console.log("supply-chain-operations: passed");
