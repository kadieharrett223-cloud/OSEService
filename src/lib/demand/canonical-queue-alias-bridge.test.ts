import { beforeEach, expect, it, vi } from "vitest";
const fixture=vi.hoisted(()=>({tables:{} as Record<string,any[]>}));
vi.mock("next/cache",()=>({unstable_cache:(fn:unknown)=>fn}));
vi.mock("@/lib/products/old-erp-product-identity",()=>({getCachedOldErpProductIdentityBySourceRecordId:async()=>({})}));
vi.mock("@/lib/supabase/admin",()=>({getSupabaseAdmin:()=>({from(table:string){
 if(!fixture.tables[table])throw Error("Unexpected table "+table);
 let rows=[...fixture.tables[table]],start=0,end=999;
 const q:any={select:()=>q,eq(k:string,v:unknown){rows=rows.filter(r=>r[k]===v);return q;},neq(k:string,v:unknown){rows=rows.filter(r=>r[k]!==v);return q;},in(k:string,values:unknown[]){rows=rows.filter(r=>values.includes(r[k]));return q;},order:()=>q,range(a:number,b:number){start=a;end=b;return q;},then(resolve:any,reject:any){return Promise.resolve({data:rows.slice(start,end+1),error:null}).then(resolve,reject);}};
 return q;
}})}));
import {loadCanonicalCustomerQueue} from "./canonical-customer-queue-loader";
const productId="four-stacker";
const label='4032-4 4032-4 "The Four Stacker" Four-Level Car Storage Lift - Triple-Capacity 5,500 / 4,400 / 4.400';
beforeEach(()=>{
 const product={id:productId,sku:"100000008",canonical_name:label,source_record_id:null};
 const records=[
 {id:"jared",number:"122295",name:"Jared McKinney",date:"2026-07-22",mapped:false,legacy:true},
 {id:"bruce",number:"127059",name:"Bruce Harvey",date:"2026-08-20",mapped:true,paused:true},
 {id:"shawn",number:"127136",name:"Shawn Fuhrman",date:"2026-09-08",mapped:true},
 {id:"voided",number:"122344",name:"Bruce Harvey",date:"2026-07-30",mapped:true,voided:true},
 ];
 const invoices=records.map(r=>({id:r.id,invoice_number:r.number,invoice_date:r.date,raw_payload:{PrivateNote:r.voided?"Voided":null,Line:[{Id:"1",DetailType:"SalesItemLineDetail",SalesItemLineDetail:{Qty:r.voided?0:1,ItemRef:{name:label}}}]},customers:{full_name:r.name}}));
 const orders=records.map(r=>({id:r.id,source_invoice_id:r.id,source_type:"QBO_INVOICE",order_number:r.number,review_status:r.id==="jared"?"PENDING_REVIEW":"APPROVED",duplicate_of_order_id:null,cancellation_status:null,created_at:r.date,first_payment_at:r.date,customers:{full_name:r.name},qbo_invoices:invoices.find(i=>i.id===r.id)}));
 fixture.tables={products:[product],product_aliases:[{id:"short",product_id:productId,alias:"4032-4"},{id:"long",product_id:productId,alias:label}],shipping_orders:orders,qbo_invoices:invoices,qbo_invoice_lines:records.map(r=>({id:r.id+"-qbo",qbo_invoice_id:r.id,qbo_line_id:"1",qbo_sku:label,product_id:r.mapped?productId:null,ordered_qty:r.voided?0:1})),shipping_order_lines:records.map(r=>({id:r.id+"-line",product_id:productId,products:product,ordered_qty:1,approved_qty:1,fulfilled_qty:0,approval_status:"APPROVED",fulfillment_status:"PENDING",fulfillment_source:r.paused?"CUSTOMER_NOT_READY":null,legacy_item_code:r.legacy?"4032-4":label,source_record_id:r.legacy?"legacy-jared":null,qbo_invoice_line_id:r.legacy?null:r.id+"-qbo",qbo_invoice_lines:r.legacy?null:{qbo_line_id:"1",qbo_sku:label},shipping_orders:orders.find(o=>o.id===r.id),inventory_allocations:r.id==="jared"?[{source_type:"CONTAINER",container_id:"249",quantity:1,allocation_status:"ALLOCATED",containers:{container_number:"249"}}]:[],priority:"NORMAL",queue_position_start:null})),fulfillments:[],reviewed_obligation_resolutions:[],manual_product_mapping_queue:[]};
});
it("restores an approved allocated legacy line through its unique full-label alias before ordering the queue",async()=>{
 const before=structuredClone(fixture.tables);
 const q=await loadCanonicalCustomerQueue({fresh:true});
 expect(q.queue.map(r=>[r.invoice,r.position])).toEqual([["122295","1"],["127136","2"]]);
 expect(q.queueByProductId.get(productId)).toHaveLength(2);
 expect(q.queue.find(r=>r.invoice==="127059")).toBeUndefined();
 expect(q.queue.find(r=>r.invoice==="122344")).toBeUndefined();
 expect(fixture.tables).toEqual(before);
});
it("does not guess across conflicting aliases",async()=>{
 fixture.tables.product_aliases.push({id:"conflict",product_id:"different-product",alias:label});
 const q=await loadCanonicalCustomerQueue({fresh:true});
 expect(q.queue.map(r=>r.invoice)).toEqual(["127136"]);
});

