-- All physical stock writes must use the ledger selected by Inventory.
-- Routes are pinned: completing an order must not change stock ownership.
create table public.inventory_stock_routes (
  product_id uuid primary key references public.products(id) on delete cascade,
  stock_product_id uuid not null references public.products(id),
  operational_key text not null check (length(operational_key)>0),
  created_at timestamptz not null default now()
);
create index inventory_stock_routes_key_idx on public.inventory_stock_routes(operational_key);
create index inventory_stock_routes_owner_idx on public.inventory_stock_routes(stock_product_id);
alter table public.inventory_stock_routes enable row level security;
revoke all on public.inventory_stock_routes from public,anon,authenticated;
grant select,insert,update,delete on public.inventory_stock_routes to service_role;
alter table public.inventory_transactions add column stock_requested_product_id uuid references public.products(id);
create index inventory_transactions_stock_requested_idx on public.inventory_transactions(stock_requested_product_id)
  where stock_requested_product_id is not null;

-- Snapshot reviewed 2026-10-20. Natural SKUs, not generated product IDs.
-- Existing stock owners stay self-owned, including groups with multiple legacy ledgers.
insert into public.inventory_stock_routes(product_id,stock_product_id,operational_key)
select p.id,owner.id,v.operational_key from (values
('4032XL','4032XL','4032XL'),
('2PDDA-10','000004','2PDDA10'),
('2PBP-12','000007','2PBP12'),
('2PCFHD-12','2PCFHD-12','2PCFHD12'),
('2PCFHD-15','000009','2PCFHD15'),
('4PML-9','000011','4PML9'),
('4PHR-9X','000012','4PHR9X'),
('4PC-6','000235','4PC6'),
('4PXL-10','4PXL-10','4PXL10'),
('4PXW-10','4PXW-10','4PXW10'),
('4PHDXL-12','000019','4PHDXL12'),
('4032-6','000024','40326'),
('MRSL-75','000038','MRSL75'),
('FRSL-78','FRSL-78','FRSL78'),
('HPU1103','HPU1103','HPU1103'),
('HPU2203','HPU2203','HPU2203'),
('HLCJ-6','HLCJ-6','HLCJ6'),
('FBCJ-6','FBCJ-6','FBCJ6'),
('AR-1','AR-1','AR1'),
('OD-A30','OD-A30','ODA30'),
('OD-7170','000081','OD7170'),
('4PCA','000107','4PCA'),
('222','222','RIGHTARROWEXIT'),
('HK-10PLFM','000086','10PLFM'),
('KT-B750','KT-B750','KTB750'),
('KT-M150','000190','KTM150'),
('4032-4','4032-4','40324'),
('INSTALLATION SERVICE','INSTALLATION SERVICE','INSTALL'),
('000228','000228','4P4032XL'),
('T650','000042','T650'),
('T620','T620','T620'),
('W820','W820','W820'),
('YZRCJ-7','000063','YZRCJ7'),
('UHJS-750','UHJS-750','UHJS750'),
('TJ1101A','000179','TJ1101A'),
('TJ1102','000180','TJ1102'),
('000010','000010','4PML8A'),
('193','193','4PHR9'),
('000011','000011','4PML9'),
('RJT-10','000095','RJT10'),
('000002','000002','2PCF9'),
('000004','000004','2PDDA10'),
('000005','000005','2PBP10'),
('000006','000006','2PBPXW10'),
('000007','000007','2PBP12'),
('000008','2PCFHD-12','2PCFHD12'),
('000009','000009','2PCFHD15'),
('000012','000012','4PHR9X'),
('000013','000013','4PC6'),
('000014','000014','4PXL10B'),
('000015','000015','4PXLA10'),
('000016','4PXW-10','4PXW10'),
('000018','000018','4PHDXLA11'),
('000019','000019','4PHDXL12'),
('000020','000020','4PHDXLA12'),
('000026','000026','4PHDXLA22'),
('000028','000028','4PHDXLA27'),
('000029','000029','4PHDXLA33'),
('000030','000030','4PHDXL33'),
('000035','000035','R45'),
('000036','000036','RT1'),
('000128','000128','SCPBP9'),
('223','223','ENTRANCELEFTARROW'),
('256','256','HPU1103PKG'),
('257','257','HPU2203PKG'),
('258','258','HPU2204PKG'),
('000024','000024','40326'),
('000027','000027','4PHDXL27'),
('000034','000034','YM021500P'),
('000037','000037','HDML16'),
('000039','FRSL-78','FRSL78'),
('000040','000040','MRSL6'),
('000044','000044','W690'),
('000042','000042','T650'),
('000043','T620','T620'),
('000045','W820','W820'),
('000046','000046','W810'),
('000053','000053','WFCC'),
('000051','000051','MWA1'),
('000052','000052','MATV'),
('000054','000054','MCA'),
('000061','000061','HPU1101'),
('000062','000062','HPU1102'),
('000064','000064','HPU1104'),
('000063','000063','YZRCJ7'),
('000065','000065','HLCJ14'),
('000066','000066','HDMLJ'),
('000067','000067','4P20J'),
('000073','000073','4PSR214'),
('000076','000076','YZAR1'),
('000077','000077','YZHR10P'),
('000078','000078','AW32'),
('000079','000079','EPOXY132488'),
('SCAL-9','SCAL-9','SCAL9'),
('000080','OD-A30','ODA30'),
('000081','000081','OD7170'),
('000082','000082','OD3198A'),
('000083','000083','OD3198'),
('000086','000086','10PLFM'),
('000087','000087','4PTA6'),
('000088','000088','CJE'),
('000089','000089','2PFC'),
('000090','000090','LP1'),
('000108','000108','APU'),
('000092','000092','4PTT8A'),
('000170','000170','4PTT9X'),
('000167','000167','4PTTXL10'),
('000094','000094','ARJT'),
('000182','000182','RJTU'),
('000096','000096','4PDT37'),
('000179','000179','TJ1101A'),
('000099','000099','3SEA10'),
('000103','000103','CJ'),
('000104','000104','PEK1524'),
('000105','000105','PEK1536'),
('000106','000106','7601200ARM9'),
('000109','000109','HCDD10'),
('000110','000110','HCHR9'),
('000111','000111','HCHD14'),
('000113','000113','HCCF10'),
('000115','000115','10SJT'),
('000120','000120','RJT'),
('000122','000122','SST'),
('000127','000127','PCHR9'),
('000129','000129','HAND'),
('000133','000133','COBBP9'),
('000143','000143','PBSML8A'),
('000145','000145','CYM021500P'),
('000147','000147','SSTT1012'),
('000148','000148','24VCS'),
('000102','000102','HR10XL'),
('000175','000175','220VPUMPSTATION'),
('175','175','220VPUMPSTATION'),
('000058','000058','HPU2204'),
('180','180','PPBS14'),
('000031','000031','R30'),
('000032','000032','R45'),
('000033','000033','RT1'),
('000041','000041','A10EX'),
('000048','000048','A9800'),
('000050','000050','LACB1'),
('000055','000055','HPU1101'),
('000056','000056','HPU1102'),
('000057','000057','HPU1104'),
('000059','000059','HPUMRSL6'),
('000184','000184','AR'),
('000070','000070','AR4'),
('000166','000166','AP4PML8A'),
('000074','000074','AP4PHR9'),
('000091','000091','2PRP'),
('000176','000176','APU'),
('000093','000093','10SJT'),
('000097','000097','4PDT45'),
('000101','000101','PEK910'),
('000114','000114','HOC2'),
('174','174','RV1'),
('188','188','ALTT1012'),
('189','189','SSTT1012'),
('190','190','24VCS'),
('000151','000151','METALSIGNS'),
('178','178','24VCB'),
('183','183','FBT1819'),
('192','192','COREVETTE'),
('202','202','CORVETTEGRILL'),
('000191','KT-B750','KTB750'),
('000190','000190','KTM150'),
('000194','000194','V8'),
('000195','000195','CHEVYPARTSINASTEELCAN36'),
('181','181','CSS14'),
('000068','000068','AR2'),
('000069','000069','AR3'),
('000162','000162','AP4PXL10'),
('000075','000075','AP10PLFM'),
('000084','000084','TDF'),
('000107','000107','4PCA'),
('000116','000116','HSKBPXW10'),
('000121','000121','CCF12'),
('196','196','SST'),
('000130','000130','SCPBP12'),
('000131','000131','CPBCF9'),
('176','176','SB1'),
('186','186','MCWC16'),
('000149','000149','DPRP1'),
('000150','000150','NEONSIGNS'),
('179','179','3DAM'),
('182','182','PBS8A'),
('185','185','FBC1819'),
('197','197','PVOT'),
('198','198','2PTAB'),
('200','200','STICKERSOLYMPIC'),
('201','201','STICKERSWARNING'),
('203','203','CAMAROGRILL'),
('204','204','IMPALAGRILL'),
('205','205','CHEVYBOWTIE'),
('206','206','CHEVROLETBACKING'),
('207','207','CHEVYTRUCKSVC'),
('208','208','ROWNEON'),
('210','210','MOBILGASROTATING'),
('211','211','LARGEPEGASUS'),
('212','212','SINCLAIRDINO'),
('213','213','FLYINGAGAS'),
('214','214','RUSTICPEGASUSMSC'),
('215','215','MEDIUMPEGASUS'),
('217','217','CHEVYFRONTEND'),
('218','218','RECTCHEVYSVC'),
('219','219','FORDBIRDSVC'),
('220','220','PONTIACARROWSVC'),
('221','221','RUSTICLEFTARROW'),
('224','224','DODGEAPPROVEDSVC'),
('225','225','SMALLDRIVEPEGASUS'),
('227','227','GRUMPYCHEVY'),
('229','229','4PHR10X'),
('000229','000229','4PML9B'),
('000178','HPU1103','HPU1103'),
('4032S','4032S','4032S'),
('000071','000071','4PSR210'),
('000072','000072','4PSR29'),
('000085','000085','4PTA3'),
('000169','000169','4PTT9'),
('000171','000171','4PJT9X10'),
('000172','000172','4PJT8A9'),
('000177','000177','HR8'),
('000168','000168','UHS5075'),
('000098','000098','HPJV'),
('000112','000112','HCBP10'),
('000117','000117','SKCF9'),
('000118','000118','SKBP10'),
('000119','000119','OCS1'),
('000124','000124','CCF15'),
('000125','000125','CBP10'),
('000126','000126','AB1'),
('000132','000132','PSDD10'),
('000134','000134','COBCF10'),
('000135','000135','COBBP12'),
('000138','000138','HLLS1'),
('000140','000140','SB1'),
('000141','000141','PBSHD14'),
('000142','000142','CSSHD14'),
('000144','000144','MCWC16'),
('195','195','CHEVYPARTS'),
('000233','000233','SCW'),
('000234','000234','FBARALUMINUMRAMPS'),
('000236','000236','DISCOUNT1DISCOUNTPRODUCT'),
('000237','000237','2KWPOWER'),
('000155','000155','UHS7075'),
('000154','000154','J2707'),
('000188','000188','10RJTROLLINGTOOLTRAY'),
('000187','000187','4PTT'),
('000269','000269','1FD78301FF714348B8279F00F62C9E90'),
('266','HPU2203','HPU2203'),
('YZSCJ-7','YZSCJ-7','YZSCJ7'),
('100000003','100000003','YZRCJ35'),
('000001','000001','2PBP8'),
('2PBP-8','000001','2PBP8'),
('000003','000003','2PCFXL10'),
('2PCFXL-10','000003','2PCFXL10'),
('000246','000246','HPU2204'),
('000174','000174','ARJT'),
('000153','000153','J2718'),
('000157','000157','UHS750'),
('000161','000161','RCS4'),
('000165','000165','SCPXW10'),
('000163','000163','SB2'),
('000159','000159','HOH4'),
('000160','000160','RCS2'),
('000248','000248','SDFSD'),
('000164','000164','SCP9X'),
('000158','000158','HOH2'),
('100000000','100000000','HPUL2204'),
('000186','000186','8PTA'),
('100000001','100000001','HPUL2203'),
('100000002','100000002','HPUL1103'),
('100000004','100000004','YZRCJ35HP'),
('100000006','100000006','4PHDXLA10'),
('100000007','100000007','4PDTPC6'),
('100000008','100000008','4032440324THEFOURSTACKERFOURLEVELCARSTORAGELIFTTRIPLECAPACITY550044004400'),
('000235','000235','4PC6'),
('000021','000021','4PHDXLA14'),
('000023','000023','4P4032XL'),
('000025','000025','4PHDXL22'),
('MRSL-6','000040','MRSL6'),
('000047','000047','T999E'),
('000049','000049','AS800'),
('000123','000123','HBCF12'),
('000137','000137','LS1'),
('000139','000139','RV1'),
('000146','000146','ALTT1012'),
('177','177','OV1'),
('199','199','JBPARKING'),
('209','209','FLYINGAROTATING'),
('100000005','100000005','4PHDARJ'),
('000181','000181','HDMBL8'),
('000247','000247','000247'),
('JVCJ','JVCJ','JVCJ6'),
('000152','000152','HR10'),
('000173','4PXL-10','4PXL10'),
('10000006','10000006','HDMBL10'),
('000022','000022','4PHDXLA15'),
('000038','000038','MRSL75'),
('000095','000095','RJT10'),
('000156','UHJS-750','UHJS750'),
('000180','000180','TJ1102'),
('000100','000100','3SEA12'),
('000136','000136','CV1'),
('184','184','3D1819'),
('187','187','YM021500PC'),
('216','216','MEDIUMRUSTICPEGASUS'),
('226','226','DODGEDEPENDABLESVC'),
('000183','000183','HDMBL9'),
('000270','000270','E560E9310DF7489183CB2AE3F5D5641F'),
('000060','HLCJ-6','HLCJ6')
) as v(sku,owner_sku,operational_key)
join public.products p on p.sku=v.sku
join public.products owner on owner.sku=v.owner_sku;


create function public.route_inventory_stock_insert()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  v_requested uuid := new.product_id;
  v_owner uuid;
  v_key text;
  v_sku text;
  v_count integer;
  v_before numeric;
  v_existing public.inventory_transactions%rowtype;
  v_shipped_at timestamptz;
  v_last_count timestamptz;
begin
  if new.bucket<>'ON_FLOOR' then return new; end if;
  select r.stock_product_id,r.operational_key into v_owner,v_key
    from public.inventory_stock_routes r where r.product_id=v_requested;

  if not found then
    -- New real catalog codes can join an established exact operational key.
    -- Never infer a stock identity from a descriptive name or recycled numeric SKU.
    select p.sku into v_sku from public.products p where p.id=v_requested;
    if v_sku is null or btrim(v_sku)='' or v_sku ~ '^\d+$' then
      raise exception 'Stock ownership needs review for this product. No inventory changed.';
    end if;
    v_key:=regexp_replace(upper(btrim(v_sku)),'[^A-Z0-9]','','g');
    if regexp_replace(upper(btrim(v_sku)),'^(HL|HK|FB|YZ)-','') <> upper(btrim(v_sku))
       and regexp_replace(regexp_replace(upper(btrim(v_sku)),'^(HL|HK|FB|YZ)-',''),'[^A-Z0-9]','','g') <> 'AR1' then
      v_key:=regexp_replace(regexp_replace(upper(btrim(v_sku)),'^(HL|HK|FB|YZ)-',''),'[^A-Z0-9]','','g');
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inventory-stock:'||v_key,0));
    select count(distinct r.stock_product_id),min(r.stock_product_id::text)::uuid into v_count,v_owner
      from public.inventory_stock_routes r where r.operational_key=v_key;
    if v_count>1 then
      raise exception 'Multiple stock owners require review for %. No inventory changed.',v_sku;
    end if;
    v_owner:=coalesce(v_owner,v_requested);
    insert into public.inventory_stock_routes(product_id,stock_product_id,operational_key)
      values(v_requested,v_owner,v_key);
  else
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inventory-stock:'||v_key,0));
  end if;

  -- Refuse chains, missing owners, and an accidental route into another product.
  if not exists(select 1 from public.inventory_stock_routes r
    where r.product_id=v_owner and r.stock_product_id=v_owner and r.operational_key=v_key) then
    raise exception 'Invalid stock owner; review required. No inventory changed.';
  end if;

  -- A retry is a no-op, never another physical movement. A conflicting payload
  -- is an error, not a hidden rewrite of the original event.
  if new.source_event_key is not null then
    select * into v_existing from public.inventory_transactions t
      where t.source_type=new.source_type and t.source_event_key=new.source_event_key;
    if found then
      if v_existing.delta is distinct from new.delta or
         coalesce(v_existing.stock_requested_product_id,v_existing.product_id)<>v_requested then
        raise exception 'Stock event already exists with different details. No inventory changed.';
      end if;
      return null;
    end if;
  end if;

  -- An old delivery entered today must not take stock counted AFTER delivery.
  -- Same-day dates are not precise enough to infer inclusion in a recount.
  if new.source_type='FULFILLMENT' and new.delta<>0 and
     (new.source_event_key like 'ORDER_SHIPMENT:%' or new.source_event_key like 'ORDER_SHIPMENT_EDIT:%') then
    select s.shipped_at into v_shipped_at from public.order_shipments s
      where s.id::text=split_part(new.source_event_key,':',2);
    select max(t.created_at) into v_last_count from public.inventory_transactions t
      join public.inventory_stock_routes r on r.product_id=t.product_id
      where r.operational_key=v_key and r.stock_product_id=r.product_id and t.bucket='ON_FLOOR'
        and t.source_type in ('ADJUSTMENT','RECOUNT');
    if (v_shipped_at at time zone 'America/Los_Angeles')::date <
       (v_last_count at time zone 'America/Los_Angeles')::date then
      raise exception 'Shipment predates the latest stock recount. Use historical non-inventory completion after review; no stock was deducted.';
    end if;
  end if;

  select coalesce(sum(t.delta),0) into v_before from public.inventory_transactions t
    where t.product_id=v_owner and t.bucket='ON_FLOOR';
  new.stock_requested_product_id:=v_requested;
  new.product_id:=v_owner;
  new.before_qty:=v_before;
  new.after_qty:=v_before+new.delta;
  if v_owner<>v_requested then
    new.reason:=coalesce(new.reason,'Stock movement')||' [routed to physical stock ledger]';
    insert into public.audit_log(entity_type,entity_id,action,details)
      values('product',v_owner,'STOCK_LEDGER_ROUTED',jsonb_build_object(
        'requested_product_id',v_requested,'stock_product_id',v_owner,
        'source_type',new.source_type,'source_event_key',new.source_event_key,
        'delta',new.delta,'before_qty',new.before_qty,'after_qty',new.after_qty));
  end if;
  return new;
end;
$$;
revoke all on function public.route_inventory_stock_insert() from public,anon,authenticated;
grant execute on function public.route_inventory_stock_insert() to service_role;
create trigger route_inventory_stock_insert before insert on public.inventory_transactions
  for each row execute function public.route_inventory_stock_insert();
