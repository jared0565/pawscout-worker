// Partners view browser JS. Same template-literal rules as inbox-js/audit-js:
// browser JS inside a TS template literal - no backticks or dollar-brace,
// double-escape backslashes, esc() every dynamic value.
//
// Safety notes:
// - Voucher ids ride in ESCAPED data attributes resolved by click delegation,
//   never string-built into inline onclick JS (same XSS discipline as Audit,
//   even though partner details are owner-entered rather than inbound mail).
// - Revoke and mark-paid are money-adjacent, so they use a two-click ARMED
//   button (click once, the label asks to confirm, click again within 4s).
//   window.confirm is avoided because the embedded admin iframe can swallow it.
export const partnersJs = `
// --- Partners: voucher list + register form + orders modal ---
function prtMoney(n){ return '£'+(Number(n)||0).toFixed(2); }
function prtWhen(iso){ if(!iso) return ''; var d=new Date(iso); return isNaN(d.getTime())?esc(iso):esc(d.toLocaleDateString()); }
function prtChipHtml(t,cls){ return '<span class="prt-chip '+cls+'">'+esc(t)+'</span>'; }
function prtStatusChip(s){
  if(s==='live') return prtChipHtml('live','prt-live');
  if(s==='revoked') return prtChipHtml('revoked','prt-revoked');
  return prtChipHtml('expired','prt-expired');
}
function prtRowHtml(p){
  var title=(p.name||p.email)+' · '+p.code;
  var actions='<button class="ghost" type="button" data-prt-orders="'+esc(p.voucherId)+'" data-prt-title="'+esc(title)+'">Orders</button>';
  if(p.owed>0) actions+='<button class="ghost" type="button" data-prt-paid="'+esc(p.voucherId)+'">Mark commission paid ('+prtMoney(p.owed)+')</button>';
  if(p.status==='live') actions+='<button class="ghost" type="button" data-prt-revoke="'+esc(p.voucherId)+'">Revoke</button>';
  // Marketing opt-in (Campaigns audience): flip ONLY on the partner's own yes -
  // partnership correspondence alone never puts anyone on the campaign list.
  actions+=p.marketingConsent
    ?'<button class="ghost" type="button" data-prt-consent="'+esc(p.partnerId)+'" data-prt-consent-on="0">Remove updates opt-in</button>'
    :'<button class="ghost" type="button" data-prt-consent="'+esc(p.partnerId)+'" data-prt-consent-on="1">Mark updates opt-in</button>';
  return '<div class="prt-row">'
    +'<div class="prt-head"><span class="prt-who">'+esc(p.name||p.email)+'</span>'
    +(p.name?'<span class="prt-mail">'+esc(p.email)+'</span>':'')
    +'<span class="prt-code">'+esc(p.code)+'</span>'
    +prtStatusChip(p.status)
    +(p.marketingConsent?prtChipHtml('updates: opted in','prt-live'):'')
    +'<span class="muted" style="font-size:12px">'+esc(p.pctOff)+'% off, '+esc(p.commissionPct)+'% commission</span>'
    +'<span class="prt-time">'+(p.status==='live'?'ends ':'ended ')+prtWhen(p.endsAt)+'</span></div>'
    +'<div class="prt-stats">'
    +'<span>Orders <strong>'+esc(p.uses||0)+'</strong></span>'
    +'<span>Gross <strong>'+prtMoney(p.gross)+'</strong></span>'
    +'<span>Discount given <strong>'+prtMoney(p.discount)+'</strong></span>'
    +'<span>Commission owed <strong>'+prtMoney(p.owed)+'</strong></span>'
    +'<span>Paid out <strong>'+prtMoney(p.paid)+'</strong></span>'
    +(p.lastOrderAt?'<span>Last order '+prtWhen(p.lastOrderAt)+'</span>':'')
    +'</div>'
    +'<div class="prt-actions">'+actions+'</div>'
    +'</div>';
}
async function loadPartners(){
  try{
    var r=await api('/partners',{});
    if(!r.ok){ setMsg('prt-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    var box=el('prt-list'); if(!box) return;
    var h='';
    for(var i=0;i<r.partners.length;i++) h+=prtRowHtml(r.partners[i]);
    box.innerHTML=h||'<p class="muted">No partners yet. Create a discount code in Shopify admin, then register it below to start a trial.</p>';
  }catch(e){ setMsg('prt-msg','Could not load partners.','no'); }
}
async function registerPartner(){
  var body={
    email:el('prt-email').value.trim(),
    code:el('prt-code').value.trim(),
    pctOff:Number(el('prt-pct').value),
    commissionPct:Number(el('prt-comm').value),
    endsAt:el('prt-ends').value
  };
  var nm=el('prt-name').value.trim(); if(nm) body.name=nm;
  var ch=el('prt-channel').value.trim(); if(ch) body.channel=ch;
  var no=el('prt-notes').value.trim(); if(no) body.notes=no;
  setMsg('prt-reg-msg','Registering…','muted');
  try{
    var r=await api('/partners/create',body);
    if(!r.ok){ setMsg('prt-reg-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('prt-reg-msg','Registered. Orders using the code will appear within about 15 minutes of being placed.','ok');
    el('prt-code').value=''; el('prt-notes').value='';
    loadPartners();
  }catch(e){ setMsg('prt-reg-msg','Could not register the voucher.','no'); }
}
// Two-click arming for money-adjacent actions: first click asks, second (within
// 4 seconds) fires. Never the native confirm dialog - the admin iframe may
// suppress it.
function prtArm(btn,ask){
  if(btn.getAttribute('data-armed')==='1') return true;
  btn.setAttribute('data-armed','1');
  btn.setAttribute('data-orig',btn.textContent);
  btn.textContent=ask;
  setTimeout(function(){
    if(btn&&btn.getAttribute('data-armed')==='1'){
      btn.removeAttribute('data-armed');
      btn.textContent=btn.getAttribute('data-orig')||ask;
    }
  },4000);
  return false;
}
async function runVoucherAction(voucherId,action,okText){
  try{
    var r=await api('/partners/voucher',{voucherId:voucherId,action:action});
    if(!r.ok){ setMsg('prt-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('prt-msg',okText,'ok');
    loadPartners();
  }catch(e){ setMsg('prt-msg','Action failed.','no'); }
}
async function setPartnerConsent(partnerId,on){
  try{
    var r=await api('/partners/consent',{partnerId:partnerId,on:on});
    if(!r.ok){ setMsg('prt-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('prt-msg',on?'Marked as opted in to partner updates. They are now in the Campaigns partner audience.':'Opt-in removed. They will not receive partner campaigns.','ok');
    loadPartners();
  }catch(e){ setMsg('prt-msg','Action failed.','no'); }
}
// --- Orders modal ---
function prtOrderRowHtml(o){
  var chips=o.eligible?prtChipHtml('counted','prt-live'):prtChipHtml((o.financialStatus||'not counted').toLowerCase(),'prt-expired');
  if(o.paidOutAt) chips+=prtChipHtml('paid out','prt-expired');
  return '<div class="prt-order-row">'
    +'<strong>'+esc(o.name||o.id)+'</strong>'+chips
    +'<span class="muted">'+prtWhen(o.placedAt)+'</span>'
    +'<span class="prt-time">gross '+prtMoney(o.gross)+', discount '+prtMoney(o.discount)+', commission '+prtMoney(o.commission)+'</span>'
    +'</div>';
}
async function openPartnerOrders(voucherId,title){
  try{
    var r=await api('/partners/orders',{voucherId:voucherId});
    if(!r.ok){ setMsg('prt-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    var t=el('prt-orders-title'); if(t) t.textContent=title||'Voucher orders';
    var box=el('prt-orders');
    if(box){
      var h='';
      for(var i=0;i<r.orders.length;i++) h+=prtOrderRowHtml(r.orders[i]);
      box.innerHTML=h||'<p class="muted">No orders with this code yet.</p>';
      box.scrollTop=0;
    }
    var ov=el('prt-overlay'); if(ov){ ov.hidden=false; window.__modalOpen=true; }
  }catch(e){ setMsg('prt-msg','Could not load the orders.','no'); }
}
function closePartnerOrders(){
  var ov=el('prt-overlay');
  if(ov) ov.hidden=true;
  window.__modalOpen=false;
}
(function(){
  var list=el('prt-list');
  if(list) list.addEventListener('click',function(e){
    var t=e.target;
    if(!t||!t.getAttribute) return;
    var vid=t.getAttribute('data-prt-orders');
    if(vid){ openPartnerOrders(vid,t.getAttribute('data-prt-title')||''); return; }
    vid=t.getAttribute('data-prt-revoke');
    if(vid&&prtArm(t,'Click again to revoke')) runVoucherAction(vid,'revoke','Revoked on record. Now disable the code itself in Shopify admin under Discounts.');
    if(vid) return;
    vid=t.getAttribute('data-prt-consent');
    if(vid){ setPartnerConsent(vid,t.getAttribute('data-prt-consent-on')==='1'); return; }
    vid=t.getAttribute('data-prt-paid');
    if(vid&&prtArm(t,'Click again to confirm payout')) runVoucherAction(vid,'mark_paid','Commission marked as paid out.');
  });
  var ov=el('prt-overlay');
  if(ov) ov.addEventListener('click',function(e){ if(e.target===ov) closePartnerOrders(); });
  // Close on Escape when THIS overlay is visible (gate on visibility, not
  // window.__modalOpen: the Audit escape handler also fires and resets that).
  window.addEventListener('keydown',function(e){ var o=el('prt-overlay'); if(e.key==='Escape'&&o&&!o.hidden) closePartnerOrders(); });
  var ends=el('prt-ends');
  if(ends&&!ends.value){ var d=new Date(Date.now()+30*86400000); ends.value=d.toISOString().slice(0,10); }
})();
`;
