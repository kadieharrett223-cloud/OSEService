import {expect,it} from "vitest";
import {getCanonicalPhysicalOrderSummary,remainingCanonicalPhysicalLineIds,type PhysicalFulfillmentLine} from "./physical-fulfillment";
const payload={Line:["4PC-6","HPU2203","AR-1","URJT-45","4PDT (set of 3 drip trays)"].map((name,i)=>({Id:String(i+1),DetailType:"SalesItemLineDetail",SalesItemLineDetail:{Qty:1,ItemRef:{name}}}))};
function pending(id:string,product:string,index:number):PhysicalFulfillmentLine{
 return{id,product_id:product,qbo_invoice_line_id:id+"-qbo",qbo_invoice_lines:{qbo_line_id:String(index+1),qbo_sku:payload.Line[index].SalesItemLineDetail.ItemRef.name},products:{sku:"000"+index,canonical_name:product},ordered_qty:1,approved_qty:1,fulfilled_qty:0,fulfillment_status:"PENDING"};
}
it("keeps Alan12581 four shipped units closed and selects only AR1 without modifying historical quantities",()=>{
 const rows=[pending("lift","lift",0),pending("motor","motor",1),pending("ramp","ramp",2),pending("tray-qbo","jack-tray",3),pending("drip-qbo","drip-trays",4)];
 rows[0]={...rows[0],fulfilled_qty:1,fulfillment_status:"FULFILLED"};
 rows[1]={...rows[1],fulfilled_qty:1,fulfillment_status:"FULFILLED"};
 rows.push({...pending("tray-legacy","jack-tray",3),qbo_invoice_line_id:null,qbo_invoice_lines:null,fulfilled_qty:1,fulfillment_status:"FULFILLED"});
 rows.push({...pending("drip-legacy","drip-trays",4),qbo_invoice_line_id:null,qbo_invoice_lines:null,fulfilled_qty:1,fulfillment_status:"FULFILLED"});
 const before=structuredClone(rows);
 const summary=getCanonicalPhysicalOrderSummary({rawPayload:payload,lines:rows});
 expect(summary).toMatchObject({ordered:5,fulfilled:4,remaining:1,isComplete:false});
 expect([...remainingCanonicalPhysicalLineIds(summary)]).toEqual(["ramp"]);
 expect(rows).toEqual(before);
});
it("does not reuse a legacy completion across multiple live QBO items mapped to one product",()=>{
 const rows=[pending("first","same",0),pending("second","same",1),{...pending("legacy","same",0),qbo_invoice_line_id:null,qbo_invoice_lines:null,fulfilled_qty:1,fulfillment_status:"FULFILLED"}];
 const summary=getCanonicalPhysicalOrderSummary({rawPayload:{Line:payload.Line.slice(0,2)},lines:rows});
 expect(summary.fulfilled).toBe(0);
});

