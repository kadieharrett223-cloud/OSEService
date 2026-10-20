import { readFileSync } from 'node:fs';
import { buildStockRoutes } from '../src/lib/inventory/stock-routing';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const routes = buildStockRoutes(data.products, data.aliases, data.archive, data.transactions, data.lines);
const skuById = new Map(data.products.map((p: {id:string;sku:string}) => [p.id,p.sku]));
const quote = (s: unknown) => "'" + String(s).replaceAll("'", "''") + "'";
console.log("-- Snapshot reviewed 2026-10-20. Natural SKUs, not generated product IDs.\n-- Existing stock owners stay self-owned, including groups with multiple legacy ledgers.\ninsert into public.inventory_stock_routes(product_id,stock_product_id,operational_key)\nselect p.id,owner.id,v.operational_key from (values\n" + routes.map(r => `(${quote(skuById.get(r.product_id))},${quote(skuById.get(r.stock_product_id))},${quote(r.operational_key)})`).join(',\n') + "\n) as v(sku,owner_sku,operational_key)\njoin public.products p on p.sku=v.sku\njoin public.products owner on owner.sku=v.owner_sku;");
