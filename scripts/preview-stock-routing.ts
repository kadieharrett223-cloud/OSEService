import { readFileSync } from 'node:fs';
import { inventoryOperationalIdentity, stockEditContext } from '../src/lib/inventory/stock-edit-context';
import { canonicalSkuKey } from '../src/lib/products/canonical-sku';
const d = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { operationalSkuByProduct } = inventoryOperationalIdentity(d.products, d.aliases, d.archive, d.lines);
const groups = new Map<string, any[]>();
for (const p of d.products) {
  const key = canonicalSkuKey(operationalSkuByProduct.get(p.id) ?? p.sku) || p.id;
  groups.set(key, [...(groups.get(key) ?? []), p]);
}
for (const [key, products] of groups) {
  const sku = operationalSkuByProduct.get(products[0].id) ?? products[0].sku;
  const context = stockEditContext(d.products, d.aliases, d.archive, d.transactions, sku, d.lines);
  if (products.length < 2) continue;
  const txs = d.transactions.filter((t: any) => products.some(p => p.id === t.product_id));
  const countAt = txs.filter((t:any) => context.ownerIds.includes(t.product_id) && ['ADJUSTMENT', 'RECOUNT'].includes(t.source_type)).map((t:any) => t.created_at).sort().at(-1);
  const missed = txs.filter((t:any) => !context.ownerIds.includes(t.product_id) && t.source_type === 'FULFILLMENT').map((t:any) => ({...t, shippedAt:d.shipments.find((s:any) => s.id === t.source_event_key?.split(':')[1])?.shipped_at}));
  const afterCount = missed.filter((t:any) => countAt && t.shippedAt && new Date(t.shippedAt)>new Date(countAt));
  if (process.argv.includes('--compact')) console.log(JSON.stringify({key, owners:context.ownerIds.map(id=>products.find(p=>p.id===id)?.sku), routes:products.filter(p=>!context.ownerIds.includes(p.id)).map(p=>p.sku), countAt, missed:afterCount.map((t:any)=>({id:t.id,delta:t.delta,shipped:t.shippedAt})), historical:missed.length-afterCount.length}));
  else console.log(JSON.stringify({ key, sku, ...context, countAt, products:products.map(p => ({id:p.id,sku:p.sku,name:p.canonical_name,floor:txs.filter((t:any)=>t.product_id===p.id).reduce((n:number,t:any)=>n+Number(t.delta),0)})), missed: missed.map((t:any)=>({id:t.id,delta:t.delta,created:t.created_at,shipped:t.shippedAt,afterCount: countAt && t.shippedAt ? new Date(t.shippedAt)>new Date(countAt):null}))}));
}
