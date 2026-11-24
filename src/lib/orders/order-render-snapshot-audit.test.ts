import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {it,expect,vi} from 'vitest';
const fixture=vi.hoisted(()=>({db:null as any,model:null as any}));
vi.mock('next/cache',()=>({unstable_cache:(fn:any)=>fn}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw {auditRedirect:url}},useRouter:()=>({})}));
vi.mock('@/lib/auth',()=>({requireUser:async()=>({id:'local-readonly-order-render-audit'})}));
vi.mock('@/lib/admin-access',()=>({isAdminUnlockedForUser:async()=>false}));
vi.mock('@/lib/supabase/admin',()=>({getSupabaseAdmin:()=>fixture.db}));
vi.mock('@/lib/products/package-dimensions-data',()=>({getCachedPackageDimensionsBySku:async()=>({})}));
vi.mock('@/lib/inventory/inventory-display-model',async original=>{
 const actual:any=await original();return {...actual,loadInventoryDisplayModel:async()=>fixture.model??=(await actual.loadInventoryDisplayModel())};
});
import OrderPage from '@/app/(protected)/orders/[id]/page';
import OrdersPage from '@/app/(protected)/orders/page';
import {loadInventoryDisplayModel} from '@/lib/inventory/inventory-display-model';
import {getCanonicalPhysicalOrderSummary} from '@/lib/orders/physical-fulfillment';
const dir=process.env.OCC_RECONCILIATION_SNAPSHOT ?? ''; // Required for this opt-in read-only snapshot audit.
const read=(name:string)=>JSON.parse(fs.readFileSync(path.join(dir,name+'.json'),'utf8'));
function selectedFields(row:any, selection:string):any {
 if(row==null||!selection||selection.trim()==='*')return row;
 const fields:string[]=[];let depth=0,start=0;
 for(let i=0;i<selection.length;i++){if(selection[i]==='(')depth++;if(selection[i]===')')depth--;if(selection[i]===','&&depth===0){fields.push(selection.slice(start,i).trim());start=i+1;}}
 fields.push(selection.slice(start).trim());const output:any={};
 for(const field of fields){if(!field)continue;const open=field.indexOf('(');if(open<0){if(field==='*')Object.assign(output,row);else output[field]=row[field];continue;}
  const name=field.slice(0,open).trim().split(':')[0];const inner=field.slice(open+1,field.lastIndexOf(')'));const value=row[name];output[name]=Array.isArray(value)?value.map(child=>selectedFields(child,inner)):selectedFields(value,inner);
 }return output;
}
const text=(e:any):string=>typeof e==='string'||typeof e==='number'?String(e):Array.isArray(e)?e.map(text).join(''):e?.props?text(e.props.children):'';
it.skipIf(!process.env.OCC_RECONCILIATION_SNAPSHOT)('renders every stored order and checks each invoice row against its own canonical coverage',async()=>{
 vi.stubGlobal('React',React);
 const names=['products','product_aliases','inventory_stock_routes','inventory_transactions','customers','qbo_invoices','qbo_invoice_lines','shipping_orders','shipping_order_lines','fulfillments','inventory_allocations','containers','container_lines','inventory_display_groups','reviewed_obligation_resolutions','manual_product_mapping_queue','old_erp_source_records','order_shipments','order_shipment_lines','audit_log'];
 const data:any=Object.fromEntries(names.map(n=>[n,read(n)]));Object.assign(data,read('order-render-supplemental'));
 const indexes:any=Object.fromEntries(names.map(n=>[n,new Map(data[n].map((r:any)=>[r.id??r.product_id,r]))]));
 const by=(table:string,id:any)=>indexes[table]?.get(id)??null;
 for(const i of data.qbo_invoices)i.customers=by('customers',i.customer_id);
 for(const o of data.shipping_orders){o.qbo_invoices=by('qbo_invoices',o.source_invoice_id);o.customers=by('customers',o.customer_id);}
 for(const a of data.inventory_allocations)a.containers=by('containers',a.container_id);
 for(const l of data.container_lines){l.containers=by('containers',l.container_id);l.products=by('products',l.product_id);}
 for(const l of data.shipping_order_lines){l.shipping_orders=by('shipping_orders',l.shipping_order_id);l.products=by('products',l.product_id);l.qbo_invoice_lines=by('qbo_invoice_lines',l.qbo_invoice_line_id);l.inventory_allocations=data.inventory_allocations.filter((a:any)=>a.shipping_order_line_id===l.id);}
 const detailOrders=new Map<string, any>(data.shipping_orders.map((o:any)=>[o.id,{...o,shipping_order_lines:data.shipping_order_lines.filter((l:any)=>l.shipping_order_id===o.id).map((l:any)=>{const {shipping_orders,...rest}=l;return rest})}]));
 for(const s of data.order_shipments){s.creator=data.access_users.find((u:any)=>u.id===s.created_by)??null;s.lines=data.order_shipment_lines.filter((l:any)=>l.order_shipment_id===s.id||l.shipment_id===s.id).map((l:any)=>({...l,shipping_order_lines:by('shipping_order_lines',l.shipping_order_line_id)}));}
 fixture.db={storage:{from(){return {createSignedUrl:async()=>({data:null,error:null})}}},from(table:string){
  if(!data[table])throw Error('Missing real snapshot table '+table);
  let rows=[...data[table]],from=0,to=999,detail=false,selection='*';
  const q:any={select(fields:string){selection=fields;detail=table==='shipping_orders'&&fields.includes('shipping_order_lines');return q},eq(k:string,v:any){rows=rows.filter(r=>r[k]===v);return q},neq(k:string,v:any){rows=rows.filter(r=>r[k]!==v);return q},in(k:string,v:any[]){rows=rows.filter(r=>v.includes(r[k]));return q},limit(n:number){to=n-1;return q},order(k:string,options:any={}){rows.sort((a,b)=>(options.ascending===false?-1:1)*String(a[k]??'').localeCompare(String(b[k]??'')));return q},range(a:number,b:number){from=a;to=b;return q},maybeSingle(){return Promise.resolve({data:rows[0]?selectedFields(detail?detailOrders.get(rows[0].id):rows[0],selection):null,error:null})},then(resolve:any,reject:any){return Promise.resolve({data:rows.slice(from,to+1).map(r=>selectedFields(detail?detailOrders.get(r.id):r,selection)),error:null}).then(resolve,reject)}};return q;
 }};
 const model=await loadInventoryDisplayModel();
 const reports:any[]=[];const issues:any[]=[];
 for(const order of data.shipping_orders){
  let tree:any;try{tree=await OrderPage({params:Promise.resolve({id:order.id}),searchParams:Promise.resolve({})});}catch(error:any){if(error.auditRedirect){reports.push({orderId:order.id,invoice:order.order_number,redirect:error.auditRedirect});continue;}throw error;}
  const itemRows:any[]=[];
  const visit=(e:any)=>{if(!e||typeof e!=='object')return;if(Array.isArray(e)){e.forEach(visit);return;}
   if(e.type==='details'){
    const children=React.Children.toArray(e.props.children) as any[];const summary=children.find(c=>c?.type==='summary');if(summary&&String(summary.props.className??'').includes('grid-cols-')){const cells=React.Children.toArray(summary.props.children) as any[];let selection:any=null;const find=(x:any)=>{if(!x||typeof x!=='object')return;if(Array.isArray(x)){x.forEach(find);return;}if(x.props?.line?.ownerOrderId&&x.props?.line?.remainingQty!==undefined)selection=x.props.line;find(x.props?.children)};find(cells[0]);itemRows.push({lineId:e.props.id?.slice(5)??null,sku:selection?.sku??text(cells[0]),ordered:Number(text(cells[1])),shipped:Number(text(cells[2])),needed:Number(text(cells[3])),source:text(cells[4]),eta:text(cells[5]),incoming:[...text(cells[5]).matchAll(/(?:^| \+ )([0-9.]+) ([0-9]+) · ETA/g)].reduce((sum,m)=>sum+Number(m[1]),0),status:text(cells[6]),inStock:selection?.inStock??0,selectionOwner:selection?.ownerOrderId,selectionLineId:selection?.id});}
   }
   visit(e.props?.children);
  };visit(tree);
  const scoped:any[]=[];
  for(const row of itemRows){
   const issue=(code:string)=>scoped.push({code,...row});
   if(row.needed<0||row.shipped<0||row.shipped>row.ordered)issue('ITEM_QUANTITY_ARITHMETIC');
   if(row.status==='Ready'&&(row.needed<=0||row.inStock<row.needed))issue('READY_WITHOUT_OWN_WAREHOUSE_COVERAGE');
   if(row.needed>0&&row.source==='Warehouse'&&row.inStock<row.needed)issue('WAREHOUSE_LABEL_WITHOUT_COVERAGE');
   if(row.status==='Ready'&&(row.source==='Unassigned'||row.eta==='No source available'))issue('READY_WITHOUT_SOURCE');
   if(row.selectionLineId&&row.selectionLineId!==row.lineId)issue('FULFILLMENT_SELECTION_WRONG_LINE');
   if(row.needed>0&&row.status==='Shipped')issue('OPEN_ITEM_MARKED_SHIPPED');
   if(row.selectionLineId&&row.source.includes('Needs mapping'))issue('UNMAPPED_ITEM_SELECTS_PHYSICAL_LINE');
  }
  for(const id of new Set(itemRows.map(r=>r.lineId))){
   const rows=itemRows.filter(r=>r.lineId===id&&r.needed>0);const coverage=model.coverageByLineId.get(id);
   if(coverage&&rows.reduce((s,r)=>s+r.inStock,0)>coverage.warehouseQty)scoped.push({code:'REPEATED_ROWS_DOUBLE_COUNT_WAREHOUSE',lineId:id});
  }
  const ownLines=data.shipping_order_lines.filter((l:any)=>l.shipping_order_id===order.id);const physical=getCanonicalPhysicalOrderSummary({rawPayload:order.qbo_invoices?.raw_payload,lines:ownLines});
  const report={orderId:order.id,invoice:order.order_number,qboTransaction:order.qbo_invoices?.qbo_invoice_id,customer:order.legacy_customer_name,rows:itemRows,physicalSummary:{ordered:physical.ordered,fulfilled:physical.fulfilled,remaining:physical.remaining},issues:scoped};reports.push(report);issues.push(...scoped.map(i=>({orderId:order.id,invoice:order.order_number,...i})));
  if(reports.length%200===0)console.log(JSON.stringify({orders:reports.length,issues:issues.length}));
 }
 const listTree=await OrdersPage({searchParams:Promise.resolve({tab:'orders'})});let listRows:any[]=[];
 const findList=(e:any)=>{if(!e||typeof e!=='object')return;if(Array.isArray(e)){e.forEach(findList);return;}if(e.props?.rows&&e.props?.tabCounts)listRows=e.props.rows;findList(e.props?.children)};findList(listTree);
 const listMismatches:any[]=[];for(const row of listRows){const detail=reports.find(r=>r.orderId===row.id&&!r.redirect);if(!detail||!detail.rows?.length||row.remainingQty<=0||row.tabs.includes('cancelled'))continue;const detailAvailable=detail.rows.reduce((sum:number,r:any)=>sum+r.inStock,0);const shownAvailable=[...row.remainingStatus.matchAll(/([0-9]+) (?:available|in warehouse)/g)].reduce((sum:number,m:any)=>sum+Number(m[1]),0);const detailIncoming=detail.rows.reduce((sum:number,r:any)=>sum+r.incoming,0);const shownIncoming=[...row.remainingStatus.matchAll(/([0-9]+) incoming/g)].reduce((sum:number,m:any)=>sum+Number(m[1]),0);if(detailAvailable!==shownAvailable||detailIncoming!==shownIncoming)listMismatches.push({orderId:row.id,invoice:row.invoiceNumber,customer:row.customerName,list:row.remainingStatus,listAvailable:shownAvailable,detailAvailable,detailIncoming,shownIncoming,remaining:row.remainingQty});}
 fs.writeFileSync(path.join(dir,'every-order-list-result.json'),JSON.stringify({rows:listRows.length,mismatches:listMismatches,listRows},null,2));
 const queueComparisons:any[]=[];for(const q of model.canonicalQueue.queue){let report=reports.find(r=>r.orderId===q.orderId);if(report?.redirect)report=reports.find(r=>r.orderId===report.redirect.split('/orders/')[1]?.split('?')[0]);const coverage=model.coverageByLineId.get(q.lineId);const rows=(report?.rows??[]).filter((r:any)=>r.needed>0&&(r.lineId===q.lineId||(coverage&&model.coverageByLineId.get(r.lineId)===coverage)));const warehouse=rows.reduce((sum:number,r:any)=>sum+r.inStock,0);const incoming=rows.reduce((sum:number,r:any)=>sum+r.incoming,0);if(rows.length&&(warehouse!==(coverage?.warehouseQty??0)||incoming!==(coverage?.incomingQty??0)))queueComparisons.push({orderId:q.orderId,invoice:q.invoice,lineId:q.lineId,queueWarehouse:coverage?.warehouseQty??0,orderWarehouse:warehouse,queueIncoming:coverage?.incomingQty??0,orderIncoming:incoming});}
 fs.writeFileSync(path.join(dir,'customer-list-order-comparison.json'),JSON.stringify({queueRows:model.canonicalQueue.queue.length,warehouseMismatches:queueComparisons},null,2));
 console.log(JSON.stringify({listRows:listRows.length,listMismatches:listMismatches.length,sample:listMismatches.slice(0,8)}));
 fs.writeFileSync(path.join(dir,'every-order-render-result.json'),JSON.stringify({orders:data.shipping_orders.length,rendered:reports.filter(r=>!r.redirect).length,redirects:reports.filter(r=>r.redirect).length,itemRows:reports.reduce((s,r)=>s+(r.rows?.length??0),0),issues,reports},null,2));
 console.log(JSON.stringify({orders:data.shipping_orders.length,issues:issues.length,sample:issues.slice(0,8)}));
 expect(reports.length).toBe(data.shipping_orders.length);
 expect(issues).toEqual([]);
 expect(listMismatches).toEqual([]);
 expect(queueComparisons).toEqual([]);
},600000);
