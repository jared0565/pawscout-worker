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
function prtRowHtml(p,live){
  var title=(p.name||p.email)+' · '+p.code;
  var actions='<button class="ghost" type="button" data-prt-orders="'+esc(p.voucherId)+'" data-prt-title="'+esc(title)+'">Orders</button>';
  if(p.owed>0) actions+='<button class="ghost" type="button" data-prt-paid="'+esc(p.voucherId)+'">Mark commission paid ('+prtMoney(p.owed)+')</button>';
  if(p.status==='live') actions+='<button class="ghost" type="button" data-prt-revoke="'+esc(p.voucherId)+'">Revoke</button>';
  // One-click reissue on a finished row: same partner, same terms, fresh code
  // through the normal issue flow (promo-aware timing, invite staged in the
  // Inbox when a conversation exists). Hidden while the partner has ANY live
  // code, so reissuing can never mint a duplicate active discount.
  if(p.status!=='live'&&!live[p.partnerId]) actions+='<button class="ghost" type="button" data-prt-reissue="'+esc(p.email)+'" data-prt-rename="'+esc(p.name||'')+'" data-prt-repct="'+esc(p.pctOff)+'" data-prt-recomm="'+esc(p.commissionPct)+'">Reissue</button>';
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
// Trial-code queue rows: qualified applicants parked from the Inbox. Issue is
// the one-click flow on the programme's standard terms; issuing moves them
// into the voucher rows below and stages the code invite on their thread.
function prtQueueHtml(queued){
  if(!queued||!queued.length) return '';
  var h='<div class="prt-queue"><h3>Waiting for a code ('+queued.length+')</h3>'
    +'<p class="muted" style="margin:0 0 6px;font-size:12px">Added from the Inbox. Issue when you are ready: the code is created in Shopify on the standard terms (5% off, 2% commission, 30 days) and the invite email is staged on their thread for your approval.</p>';
  for(var i=0;i<queued.length;i++){
    var q=queued[i];
    h+='<div class="prt-row"><div class="prt-head"><span class="prt-who">'+esc(q.name||q.email)+'</span>'
      +(q.name?'<span class="prt-mail">'+esc(q.email)+'</span>':'')
      +'<span class="prt-chip prt-expired">waiting for a code</span>'
      +'<span class="prt-time">queued '+prtWhen(q.queuedAt)+'</span></div>'
      +'<div class="prt-actions">'
      +'<button type="button" data-prt-issueq="'+esc(q.email)+'" data-prt-issueq-name="'+esc(q.name||'')+'">Issue code now</button>'
      +'<button class="ghost" type="button" data-prt-unqueue="'+esc(q.partnerId)+'">Remove</button>'
      +'</div></div>';
  }
  return h+'</div>';
}
async function loadPartners(){
  try{
    var r=await api('/partners',{});
    if(!r.ok){ setMsg('prt-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    var box=el('prt-list'); if(!box) return;
    var live={};
    for(var i=0;i<r.partners.length;i++){ if(r.partners[i].status==='live') live[r.partners[i].partnerId]=1; }
    var h='';
    for(var i=0;i<r.partners.length;i++) h+=prtRowHtml(r.partners[i],live);
    box.innerHTML=(prtQueueHtml(r.queued)+h)||'<p class="muted">No partners yet. Create a discount code in Shopify admin, then register it below to start a trial.</p>';
  }catch(e){ setMsg('prt-msg','Could not load partners.','no'); }
}
// Promo/scope status line: shows what voucher timing will schedule around, and
// doubles as the write_discounts grant check after the scope change.
async function loadDiscountStatus(){
  var box=el('prt-promos'); if(!box) return;
  try{
    var r=await api('/partners/discount-status',{});
    if(!r.ok){ box.textContent='Store promotion check unavailable.'; return; }
    if(!r.scope){
      box.textContent=(r.note==='reconnect_required')
        ?'Shopify has not granted discount access to PawScout yet. Open the app fresh from Shopify admin (Apps, then PawScout) and approve the updated permissions, then reload this page.'
        :'Store promotion check unavailable: '+(r.note||'unknown');
      return;
    }
    if(!r.promos.length){ box.textContent='No storewide promotion is running or scheduled: new voucher codes go live immediately.'; return; }
    var parts=[];
    for(var i=0;i<r.promos.length;i++){
      var p=r.promos[i];
      parts.push('"'+p.title+'" ('+(p.status==='ACTIVE'?'running':'scheduled')+(p.endsAt?(', ends '+prtWhen(p.endsAt)):', no end date')+')');
    }
    box.innerHTML='Storewide promotions: '+esc(parts.join(' · '))+'. New voucher codes are automatically scheduled to start after the last one ends.';
  }catch(e){ box.textContent='Store promotion check unavailable.'; }
}
// Success copy shared by the form issue and the per-row reissue: what the code
// is, when it runs (promo-deferred or immediate), and where the invite went.
function prtIssuedText(r){
  var when=r.deferredBehind
    ?('It starts after "'+r.deferredBehind+'" ends ('+prtWhen(r.startsAt)+') and runs until '+prtWhen(r.endsAt)+'.')
    :('It is live now and runs until '+prtWhen(r.endsAt)+'.');
  var where=r.invitedThreadId
    ?' The invite email carrying the code is waiting in the Inbox for your approval.'
    :' No inbox conversation exists for this email, so share the code with them yourself.';
  return 'Issued '+r.code+' ('+r.pctOff+'% off, '+r.commissionPct+'% commission). '+when+where;
}
async function issuePartnerVoucher(){
  var email=el('prt-email').value.trim();
  if(!email){ setMsg('prt-reg-msg','Enter the partner email first.','no'); return; }
  var body={
    email:email,
    pctOff:Number(el('prt-pct').value),
    commissionPct:Number(el('prt-comm').value)
  };
  var nm=el('prt-name').value.trim(); if(nm) body.name=nm;
  var ends=el('prt-ends').value;
  if(ends){
    var days=Math.round((new Date(ends+'T23:59:59Z').getTime()-Date.now())/86400000);
    if(days>=7&&days<=90) body.trialDays=days;
  }
  setMsg('prt-reg-msg','Creating the code in Shopify…','muted');
  try{
    var r=await api('/partners/issue',body);
    if(!r.ok){ setMsg('prt-reg-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('prt-reg-msg',prtIssuedText(r),'ok');
    loadPartners();
  }catch(e){ setMsg('prt-reg-msg','Could not issue the voucher.','no'); }
}
// Per-row reissue: the finished row already knows the partner and their terms,
// so this is the Issue-automatically flow with the form pre-answered. Armed
// like every consequential button (it creates a real Shopify discount).
async function reissuePartnerVoucher(btn){
  var body={
    email:btn.getAttribute('data-prt-reissue'),
    pctOff:Number(btn.getAttribute('data-prt-repct')),
    commissionPct:Number(btn.getAttribute('data-prt-recomm'))
  };
  var nm=btn.getAttribute('data-prt-rename'); if(nm) body.name=nm;
  setMsg('prt-msg','Creating the new code in Shopify…','muted');
  try{
    var r=await api('/partners/issue',body);
    if(!r.ok){ setMsg('prt-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('prt-msg',prtIssuedText(r),'ok');
    loadPartners();
  }catch(e){ setMsg('prt-msg','Could not reissue the voucher.','no'); }
}
// Queue-row issue: the standard-terms one-click path (5% off, 2% commission,
// default 30-day window; promo-aware timing like every issue). Armed - it
// creates a real Shopify discount.
async function issueQueuedPartner(btn){
  var body={email:btn.getAttribute('data-prt-issueq'),pctOff:5,commissionPct:2};
  var nm=btn.getAttribute('data-prt-issueq-name'); if(nm) body.name=nm;
  setMsg('prt-msg','Creating the code in Shopify…','muted');
  try{
    var r=await api('/partners/issue',body);
    if(!r.ok){ setMsg('prt-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('prt-msg',prtIssuedText(r),'ok');
    loadPartners();
  }catch(e){ setMsg('prt-msg','Could not issue the voucher.','no'); }
}
async function unqueuePartner(btn){
  try{
    var r=await api('/partners/queue-remove',{partnerId:btn.getAttribute('data-prt-unqueue')});
    if(!r.ok){ setMsg('prt-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('prt-msg','Removed from the queue. Queueing them again from their inbox thread still works.','ok');
    loadPartners();
  }catch(e){ setMsg('prt-msg','Could not remove them.','no'); }
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
    var msg=okText;
    if(action==='revoke') msg=r.shopifyDeactivated
      ?'Revoked, and the code has been deactivated in Shopify too - it no longer works at checkout.'
      :'Revoked on record, but Shopify did not confirm the deactivation ('+(r.shopifyNote||'unknown')+') - disable the code under Discounts in Shopify admin.';
    setMsg('prt-msg',msg,'ok');
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
    if(vid&&prtArm(t,'Click again to revoke')) runVoucherAction(vid,'revoke','Revoked.');
    if(vid) return;
    vid=t.getAttribute('data-prt-reissue');
    if(vid&&prtArm(t,'Click again to reissue')) reissuePartnerVoucher(t);
    if(vid) return;
    vid=t.getAttribute('data-prt-consent');
    if(vid){ setPartnerConsent(vid,t.getAttribute('data-prt-consent-on')==='1'); return; }
    vid=t.getAttribute('data-prt-paid');
    if(vid&&prtArm(t,'Click again to confirm payout')) runVoucherAction(vid,'mark_paid','Commission marked as paid out.');
    if(vid) return;
    vid=t.getAttribute('data-prt-issueq');
    if(vid&&prtArm(t,'Click again to issue')) issueQueuedPartner(t);
    if(vid) return;
    vid=t.getAttribute('data-prt-unqueue');
    if(vid&&prtArm(t,'Click again to remove')) unqueuePartner(t);
  });
  var ov=el('prt-overlay');
  if(ov) ov.addEventListener('click',function(e){ if(e.target===ov) closePartnerOrders(); });
  // Close on Escape when THIS overlay is visible (gate on visibility, not
  // window.__modalOpen: the Audit escape handler also fires and resets that).
  window.addEventListener('keydown',function(e){ var o=el('prt-overlay'); if(e.key==='Escape'&&o&&!o.hidden) closePartnerOrders(); });
  var ends=el('prt-ends');
  if(ends&&!ends.value){ var d=new Date(Date.now()+30*86400000); ends.value=d.toISOString().slice(0,10); }
  loadDiscountStatus();
})();
`;
