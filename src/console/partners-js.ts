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
// One voucher = one table row. All row actions live in the Actions menu: each
// actions cell carries a hidden .prt-menu-src holding the row's action buttons
// (same escaped data-prt-* attributes as always, so the same click delegation
// runs them); opening copies that HTML into the single floating #prt-float-menu
// (position:fixed) so the table's overflow-x wrapper cannot clip it. Armed
// buttons keep the menu open for their confirming second click.
function prtVoucherRowHtml(p,live){
  var title=(p.name||p.email)+' · '+p.code;
  var sub='Discount given '+prtMoney(p.discount)+' · Paid out '+prtMoney(p.paid)+(p.lastOrderAt?(' · Last order '+prtWhen(p.lastOrderAt)):'');
  var items='<button type="button" data-prt-orders="'+esc(p.voucherId)+'" data-prt-title="'+esc(title)+'" data-prt-sub="'+esc(sub)+'">Orders</button>';
  if(p.owedCleared>0) items+='<button type="button" data-prt-paid="'+esc(p.voucherId)+'" data-prt-title="'+esc(title)+'" data-prt-owed="'+prtMoney(p.owedCleared)+'">Mark cleared commission paid ('+prtMoney(p.owedCleared)+')</button>';
  if(p.status==='live') items+='<button type="button" data-prt-revoke="'+esc(p.voucherId)+'">Revoke</button>';
  // One-click reissue on a finished row: same partner, same terms, fresh code
  // through the normal issue flow (promo-aware timing, invite staged in the
  // Inbox when a conversation exists). Hidden while the partner has ANY live
  // code, so reissuing can never mint a duplicate active discount.
  if(p.status!=='live'&&!live[p.partnerId]) items+='<button type="button" data-prt-reissue="'+esc(p.email)+'" data-prt-rename="'+esc(p.name||'')+'" data-prt-repct="'+esc(p.pctOff)+'" data-prt-recomm="'+esc(p.commissionPct)+'">Reissue</button>';
  // Marketing opt-in (Campaigns audience): flip ONLY on the partner's own yes -
  // partnership correspondence alone never puts anyone on the campaign list.
  items+=p.marketingConsent
    ?'<button type="button" data-prt-consent="'+esc(p.partnerId)+'" data-prt-consent-on="0">Remove updates opt-in</button>'
    :'<button type="button" data-prt-consent="'+esc(p.partnerId)+'" data-prt-consent-on="1">Mark updates opt-in</button>';
  return '<tr>'
    +'<td class="prt-cell-who"><span class="prt-who">'+esc(p.name||p.email)+'</span>'+(p.name?'<span class="prt-mail">'+esc(p.email)+'</span>':'')+'</td>'
    +'<td><span class="prt-code">'+esc(p.code)+'</span></td>'
    +'<td>'+prtStatusChip(p.status)+(p.marketingConsent?' '+prtChipHtml('updates','prt-live'):'')+'</td>'
    +'<td class="muted">'+esc(p.pctOff)+'% / '+esc(p.commissionPct)+'%</td>'
    +'<td class="prt-num">'+esc(p.uses||0)+'</td>'
    +'<td class="prt-num">'+prtMoney(p.gross)+'</td>'
    +'<td class="prt-num">'+prtMoney(p.owedCleared)+(p.owedMaturing>0?'<div class="muted" style="font-size:11px;font-weight:400">+'+prtMoney(p.owedMaturing)+' maturing</div>':'')+'</td>'
    +'<td class="muted">'+prtWhen(p.endsAt)+'</td>'
    +'<td class="prt-actions-cell"><button class="ghost prt-menu-btn" type="button" data-prt-menu="v'+esc(p.voucherId)+'">Actions</button><div class="prt-menu-src" hidden>'+items+'</div></td>'
    +'</tr>';
}
// The floating Actions menu: one panel, repopulated per row on open. Closes on
// outside click, Escape, scroll, or reload; clicking inside never auto-closes,
// so a two-click armed action can ask and confirm without the menu vanishing.
var __prtMenuKey=null;
function prtCloseMenu(){
  var m=el('prt-float-menu'); if(!m) return;
  m.hidden=true; m.innerHTML=''; __prtMenuKey=null;
}
function prtToggleMenu(btn){
  var m=el('prt-float-menu'); if(!m) return;
  var key=btn.getAttribute('data-prt-menu');
  if(__prtMenuKey===key&&!m.hidden){ prtCloseMenu(); return; }
  var src=btn.parentNode?btn.parentNode.querySelector('.prt-menu-src'):null;
  if(!src) return;
  m.innerHTML=src.innerHTML;
  m.hidden=false;
  __prtMenuKey=key;
  var rect=btn.getBoundingClientRect();
  m.style.top=(rect.bottom+4)+'px';
  m.style.left='auto';
  m.style.right=Math.max(8,document.documentElement.clientWidth-rect.right)+'px';
}
// The "?" info popover: the long how-it-works prose lives in hidden divs in the
// view; the popover shows one of them on demand (server-authored HTML only).
function openPartnerInfo(btn){
  var src=el(btn.getAttribute('data-prt-help')||''); var ov=el('prt-info-overlay');
  if(!src||!ov) return;
  var tt=el('prt-info-title'); if(tt) tt.textContent=btn.getAttribute('data-prt-help-title')||'How this works';
  var body=el('prt-info-body'); if(body){ body.innerHTML=src.innerHTML; body.scrollTop=0; }
  ov.hidden=false; window.__modalOpen=true;
}
function closePartnerInfo(){
  var ov=el('prt-info-overlay');
  if(ov) ov.hidden=true;
  window.__modalOpen=false;
}
// Trial-code queue table: qualified applicants parked from the Inbox. Issue is
// the one-click flow on the programme's standard terms; issuing moves them
// into the voucher table below and stages the code invite on their thread.
function prtQueueHtml(queued){
  if(!queued||!queued.length) return '';
  var rows='';
  for(var i=0;i<queued.length;i++){
    var q=queued[i];
    var items='<button type="button" data-prt-issueq="'+esc(q.email)+'" data-prt-issueq-name="'+esc(q.name||'')+'">Issue code now</button>'
      +'<button type="button" data-prt-unqueue="'+esc(q.partnerId)+'">Remove from queue</button>'
      +(q.marketingConsent
        ?'<button type="button" data-prt-consent="'+esc(q.partnerId)+'" data-prt-consent-on="0">Remove updates opt-in</button>'
        :'<button type="button" data-prt-consent="'+esc(q.partnerId)+'" data-prt-consent-on="1">Mark updates opt-in</button>');
    rows+='<tr>'
      +'<td class="prt-cell-who"><span class="prt-who">'+esc(q.name||q.email)+'</span>'+(q.name?'<span class="prt-mail">'+esc(q.email)+'</span>':'')+'</td>'
      +'<td class="muted">'+prtWhen(q.queuedAt)+'</td>'
      +'<td>'+(q.marketingConsent?prtChipHtml('updates: opted in','prt-live'):'<span class="muted">no opt-in</span>')+'</td>'
      +'<td class="prt-actions-cell"><button class="ghost prt-menu-btn" type="button" data-prt-menu="q'+esc(q.partnerId)+'">Actions</button><div class="prt-menu-src" hidden>'+items+'</div></td>'
      +'</tr>';
  }
  return '<div class="prt-queue"><h3>Waiting for a code ('+queued.length+')</h3>'
    +'<p class="muted" style="margin:0 0 6px;font-size:12px">Added from the Inbox. Issue when you are ready: standard terms (5% off, 2% commission, 30 days), with the invite email staged on their thread for your approval.</p>'
    +'<div class="prt-tablewrap"><table class="prt-table"><thead><tr><th>Partner</th><th>Queued</th><th>Updates</th><th aria-label="Actions"></th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
}
async function loadPartners(){
  try{
    var r=await api('/partners',{});
    if(!r.ok){ setMsg('prt-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    var box=el('prt-list'); if(!box) return;
    prtCloseMenu(); // an open menu would reference rows about to be replaced
    var live={};
    for(var i=0;i<r.partners.length;i++){ if(r.partners[i].status==='live') live[r.partners[i].partnerId]=1; }
    var rows='';
    for(var i=0;i<r.partners.length;i++) rows+=prtVoucherRowHtml(r.partners[i],live);
    var table=rows
      ?'<div class="prt-tablewrap"><table class="prt-table"><thead><tr><th>Partner</th><th>Code</th><th>Status</th><th>Terms</th><th class="prt-num">Orders</th><th class="prt-num">Gross</th><th class="prt-num">Payable</th><th>Ends</th><th aria-label="Actions"></th></tr></thead><tbody>'+rows+'</tbody></table></div>'
      :'';
    var h=prtQueueHtml(r.queued)+table;
    box.innerHTML=(h||'<p class="muted">No partners yet. Create a discount code in Shopify admin, then register it below to start a trial.</p>')
      +'<div id="prt-float-menu" class="prt-menu" hidden></div>';
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
// --- Self-serve applications (Task 6): the funnel's own owner-review queue.
// Most applications never appear here - only stages a human must decide
// (owner_queue: former partner or over-cap; deflected: screened out but the
// owner may still want to override). Approve anyway routes through the SAME
// issueVoucher call as the automatic path (bounded starter tier); Decline
// sends the standard decline email. Both are two-click armed (prtArm), and
// every dynamic field is escaped before it reaches innerHTML.
function prtAppStageLabel(stage){
  var m={submitted:'Submitted',verified:'Verified',judging:'Judging',approved_pending_issue:'Issuing…',approved:'Approved',deflected:'Deflected',declined:'Declined',owner_queue:'Needs review'};
  return m[stage]||esc(stage);
}
function prtAppStageChipClass(stage){
  if(stage==='approved') return 'prt-live';
  if(stage==='declined') return 'prt-revoked';
  return 'prt-expired';
}
function prtAppRowHtml(a){
  var items='';
  if(a.stage==='owner_queue'||a.stage==='deflected') items+='<button type="button" data-prt-app-approve="'+esc(a.id)+'">Approve anyway</button>';
  if(a.stage!=='approved'&&a.stage!=='declined') items+='<button type="button" data-prt-app-decline="'+esc(a.id)+'">Decline</button>';
  var channelSafe=a.channelUrl&&/^https?:\/\//i.test(a.channelUrl);
  var channel=a.channelUrl
    ?(channelSafe?('<a href="'+esc(a.channelUrl)+'" target="_blank" rel="noopener noreferrer">'+esc(a.channelUrl)+'</a>'):esc(a.channelUrl))
    :'<span class="muted">no channel</span>';
  return '<tr>'
    +'<td class="prt-cell-who"><span class="prt-who">'+esc(a.name||a.email)+'</span>'+(a.name?'<span class="prt-mail">'+esc(a.email)+'</span>':'')+'</td>'
    +'<td>'+prtChipHtml(prtAppStageLabel(a.stage),prtAppStageChipClass(a.stage))+'</td>'
    +'<td class="prt-num">'+(a.score==null?'-':(esc(a.score)+'/12'))+'</td>'
    +'<td>'+channel+'</td>'
    +'<td class="muted">'+esc(a.flagsSummary||'')+'</td>'
    +'<td class="prt-actions-cell">'+(items||'<span class="muted">-</span>')+'</td>'
    +'</tr>';
}
function prtRenderSelfServeConfig(sc){
  if(!sc) return;
  var en=el('prt-ss-enabled'); if(en) en.checked=!!sc.enabled;
  var cap=el('prt-ss-cap'); if(cap) cap.value=sc.autoIssueCapPerDay;
  var sp=el('prt-ss-spend'); if(sp) sp.value=sc.screenSpendCapGbpPerDay;
  var sco=el('prt-ss-score'); if(sco) sco.value=sc.scoreThreshold;
  var us=el('prt-ss-usage'); if(us) us.value=sc.starterUsageLimit;
}
async function loadApplications(){
  try{
    var r=await api('/affiliate/applications',{});
    if(!r.ok){ setMsg('prt-app-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    prtRenderSelfServeConfig(r.selfServe);
    var box=el('prt-app-list'); if(!box) return;
    var rows='';
    for(var i=0;i<r.applications.length;i++) rows+=prtAppRowHtml(r.applications[i]);
    box.innerHTML=rows
      ?('<div class="prt-tablewrap"><table class="prt-table"><thead><tr><th>Applicant</th><th>Stage</th><th class="prt-num">Score</th><th>Channel</th><th>Notes</th><th aria-label="Actions"></th></tr></thead><tbody>'+rows+'</tbody></table></div>')
      :'<p class="muted">No self-serve applications yet.</p>';
  }catch(e){ setMsg('prt-app-msg','Could not load applications.','no'); }
}
async function prtApproveApplication(btn){
  try{
    var r=await api('/affiliate/applications/approve',{id:btn.getAttribute('data-prt-app-approve')});
    if(!r.ok){ setMsg('prt-app-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('prt-app-msg','Approved. The starter code has been issued and emailed.','ok');
    loadApplications(); loadPartners();
  }catch(e){ setMsg('prt-app-msg','Could not approve the application.','no'); }
}
async function prtDeclineApplication(btn){
  try{
    var r=await api('/affiliate/applications/decline',{id:btn.getAttribute('data-prt-app-decline')});
    if(!r.ok){ setMsg('prt-app-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('prt-app-msg','Declined.','ok');
    loadApplications();
  }catch(e){ setMsg('prt-app-msg','Could not decline the application.','no'); }
}
// --- Self-serve config (selfServe block): master enable + the four daily
// safety caps/thresholds. Saved as one full object (validateSelfServePayload
// rejects a NaN/negative/out-of-range value with a 400, never silently clamps).
async function saveSelfServeConfig(){
  var body={
    enabled:!!(el('prt-ss-enabled')&&el('prt-ss-enabled').checked),
    autoIssueCapPerDay:Number(el('prt-ss-cap').value),
    screenSpendCapGbpPerDay:Number(el('prt-ss-spend').value),
    scoreThreshold:Number(el('prt-ss-score').value),
    starterUsageLimit:Number(el('prt-ss-usage').value)
  };
  setMsg('prt-ss-msg','Saving…','muted');
  try{
    var r=await api('/affiliate/config',body);
    if(!r.ok){ setMsg('prt-ss-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('prt-ss-msg','Saved.','ok');
    prtRenderSelfServeConfig(r.selfServe);
  }catch(e){ setMsg('prt-ss-msg','Could not save settings.','no'); }
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
// --- Payout recording (2026-07-06): the accounting record. The menu item
// opens this modal instead of firing directly - a payout deserves a method and
// a transaction reference, and the armed Record button is the deliberate step.
var __prtPayoutVoucher=null;
function prtOpenPayout(btn){
  __prtPayoutVoucher=btn.getAttribute('data-prt-paid');
  var owed=btn.getAttribute('data-prt-owed')||'';
  var sub=el('prt-payout-sub'); if(sub) sub.textContent=(btn.getAttribute('data-prt-title')||'')+' · owed '+owed;
  var b=el('prt-payout-btn'); if(b){ b.disabled=false; b.textContent='Record payout of '+owed; }
  setMsg('prt-payout-msg','','muted');
  var ov=el('prt-payout-overlay'); if(ov){ ov.hidden=false; window.__modalOpen=true; }
}
function closePartnerPayout(){
  var ov=el('prt-payout-overlay');
  if(ov) ov.hidden=true;
  window.__modalOpen=false;
}
async function recordPartnerPayout(btn){
  if(!__prtPayoutVoucher) return;
  if(!prtArm(btn,'Click again to record')) return;
  btn.disabled=true;
  setMsg('prt-payout-msg','Recording the payout…','muted');
  try{
    var body={voucherId:__prtPayoutVoucher,action:'mark_paid'};
    var m=el('prt-payout-method').value.trim(); if(m) body.method=m;
    var rf=el('prt-payout-ref').value.trim(); if(rf) body.reference=rf;
    var r=await api('/partners/voucher',body);
    if(!r.ok){ setMsg('prt-payout-msg','Failed: '+(r.error||'unknown error'),'no'); btn.disabled=false; return; }
    setMsg('prt-payout-msg','Recorded '+prtMoney(r.amount)+' over '+r.ordersCovered+' orders. The statement is under Orders on their row (Statement CSV).','ok');
    el('prt-payout-method').value=''; el('prt-payout-ref').value='';
    loadPartners();
  }catch(e){ setMsg('prt-payout-msg','Could not record the payout.','no'); btn.disabled=false; }
}
// --- CSV exports: statements for accounting and later disputes. Built client
// side from the orders response (the payout figures inside it are the FROZEN
// snapshot from payout time, not the live ledger).
function prtCsvCell(v){
  v=(v==null?'':String(v));
  return (v.indexOf(',')>=0||v.indexOf('"')>=0||v.indexOf('\\n')>=0)?('"'+v.replace(/"/g,'""')+'"'):v;
}
function prtCsvDownload(name,rows){
  var lines=[];
  for(var i=0;i<rows.length;i++){
    var cells=[];
    for(var j=0;j<rows[i].length;j++) cells.push(prtCsvCell(rows[i][j]));
    lines.push(cells.join(','));
  }
  var blob=new Blob([lines.join('\\r\\n')+'\\r\\n'],{type:'text/csv;charset=utf-8'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },1000);
}
function prtStatementCsv(idx){
  var d=__prtOrdersData; if(!d||!d.payouts||!d.payouts[idx]) return;
  var p=d.payouts[idx];
  var rows=[
    ['Active Paw affiliate commission statement'],
    ['Partner',d.title||''],
    ['Payout id',p.payoutId],
    ['Payout date',p.createdAt],
    ['Method',p.method||''],
    ['Reference',p.reference||''],
    ['Orders covered',p.ordersCount],
    ['Total paid (GBP)',(Number(p.amount)||0).toFixed(2)],
    [],
    ['Order','Placed','Gross (GBP)','Discount (GBP)','Commission (GBP)']
  ];
  for(var i=0;i<p.orders.length;i++){
    var o=p.orders[i];
    rows.push([o.name||o.id,o.placedAt||'',(Number(o.gross)||0).toFixed(2),(Number(o.discount)||0).toFixed(2),(Number(o.commission)||0).toFixed(2)]);
  }
  prtCsvDownload('payout-'+String(p.createdAt||'').slice(0,10)+'-'+String(p.payoutId).slice(0,8)+'.csv',rows);
}
function exportPartnerLedger(){
  var d=__prtOrdersData; if(!d) return;
  var rows=[
    ['Active Paw affiliate ledger'],
    ['Partner',d.title||''],
    ['Exported',new Date().toISOString()],
    [],
    ['Order','Placed','Status','Counted','Gross (GBP)','Discount (GBP)','Commission (GBP)','Paid out at','Payout id']
  ];
  for(var i=0;i<d.orders.length;i++){
    var o=d.orders[i];
    rows.push([o.name||o.id,o.placedAt||'',o.financialStatus||'',o.eligible?'yes':'no',(Number(o.gross)||0).toFixed(2),(Number(o.discount)||0).toFixed(2),(Number(o.commission)||0).toFixed(2),o.paidOutAt||'',o.payoutId||'']);
  }
  prtCsvDownload('affiliate-ledger-'+new Date().toISOString().slice(0,10)+'.csv',rows);
}
// --- Orders modal ---
var __prtOrdersData=null; // last drill-down response, feeding the CSV exports
function prtOrderRowHtml(o){
  var chips=o.eligible?prtChipHtml('counted','prt-live'):prtChipHtml((o.financialStatus||'not counted').toLowerCase(),'prt-expired');
  if(o.paidOutAt) chips+=prtChipHtml('paid out','prt-expired');
  // Task 2's self-referral guard already zeroes commission on this row -
  // this badge makes that visible instead of a silent £0.
  if(o.selfReferral) chips+=prtChipHtml('self-referral','prt-revoked');
  return '<div class="prt-order-row">'
    +'<strong>'+esc(o.name||o.id)+'</strong>'+chips
    +'<span class="muted">'+prtWhen(o.placedAt)+'</span>'
    +'<span class="prt-time">gross '+prtMoney(o.gross)+', discount '+prtMoney(o.discount)+', commission '+prtMoney(o.commission)+'</span>'
    +'</div>';
}
async function openPartnerOrders(voucherId,title,sub){
  try{
    var r=await api('/partners/orders',{voucherId:voucherId});
    if(!r.ok){ setMsg('prt-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    __prtOrdersData={title:title||'',orders:r.orders||[],payouts:r.payouts||[]};
    var t=el('prt-orders-title'); if(t) t.textContent=title||'Voucher orders';
    var st=el('prt-orders-sub'); if(st) st.textContent=sub||'';
    var box=el('prt-orders');
    if(box){
      // Payout history first: each entry is the frozen accounting record, with
      // its statement one click away.
      var ph='';
      var pays=__prtOrdersData.payouts;
      if(pays.length){
        ph='<h3 style="font-size:12.5px;margin:10px 0 2px;color:var(--ink)">Payout history</h3>';
        for(var k=0;k<pays.length;k++){
          var p=pays[k];
          ph+='<div class="prt-order-row"><strong>'+prtMoney(p.amount)+'</strong>'
            +prtChipHtml(esc(p.ordersCount)+' orders','prt-expired')
            +'<span class="muted">'+prtWhen(p.createdAt)+(p.method?(' · '+esc(p.method)):'')+(p.reference?(' · ref '+esc(p.reference)):'')+'</span>'
            +'<span class="prt-time"><button class="ghost" type="button" data-prt-stmt="'+k+'">Statement CSV</button></span>'
            +'</div>';
        }
        ph+='<h3 style="font-size:12.5px;margin:12px 0 2px;color:var(--ink)">Orders</h3>';
      }
      var h='';
      for(var i=0;i<r.orders.length;i++) h+=prtOrderRowHtml(r.orders[i]);
      box.innerHTML=ph+(h||'<p class="muted">No orders with this code yet.</p>');
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
    var vid=t.getAttribute('data-prt-menu');
    if(vid){ prtToggleMenu(t); return; }
    vid=t.getAttribute('data-prt-orders');
    if(vid){ prtCloseMenu(); openPartnerOrders(vid,t.getAttribute('data-prt-title')||'',t.getAttribute('data-prt-sub')||''); return; }
    vid=t.getAttribute('data-prt-revoke');
    if(vid&&prtArm(t,'Click again to revoke')) runVoucherAction(vid,'revoke','Revoked.');
    if(vid) return;
    vid=t.getAttribute('data-prt-reissue');
    if(vid&&prtArm(t,'Click again to reissue')) reissuePartnerVoucher(t);
    if(vid) return;
    vid=t.getAttribute('data-prt-consent');
    if(vid){ setPartnerConsent(vid,t.getAttribute('data-prt-consent-on')==='1'); return; }
    vid=t.getAttribute('data-prt-paid');
    if(vid){ prtCloseMenu(); prtOpenPayout(t); return; }
    vid=t.getAttribute('data-prt-issueq');
    if(vid&&prtArm(t,'Click again to issue')) issueQueuedPartner(t);
    if(vid) return;
    vid=t.getAttribute('data-prt-unqueue');
    if(vid&&prtArm(t,'Click again to remove')) unqueuePartner(t);
  });
  // The floating Actions menu is tooltip-like: it survives clicks inside itself
  // (so armed actions can confirm) and closes on any outside click, Escape, or
  // scroll (its fixed position would drift from the row otherwise).
  document.addEventListener('click',function(e){
    var t=e.target;
    if(t&&t.closest&&(t.closest('#prt-float-menu')||t.closest('.prt-menu-btn'))) return;
    prtCloseMenu();
  });
  window.addEventListener('scroll',function(){ prtCloseMenu(); },true);
  // Statement buttons live inside the orders modal, outside the list delegation.
  var ordbox=el('prt-orders');
  if(ordbox) ordbox.addEventListener('click',function(e){
    var t=e.target;
    if(!t||!t.getAttribute) return;
    var idx=t.getAttribute('data-prt-stmt');
    if(idx!=null) prtStatementCsv(Number(idx));
  });
  var ov=el('prt-overlay');
  if(ov) ov.addEventListener('click',function(e){ if(e.target===ov) closePartnerOrders(); });
  var iov=el('prt-info-overlay');
  if(iov) iov.addEventListener('click',function(e){ if(e.target===iov) closePartnerInfo(); });
  var pov=el('prt-payout-overlay');
  if(pov) pov.addEventListener('click',function(e){ if(e.target===pov) closePartnerPayout(); });
  // Close on Escape when THIS overlay is visible (gate on visibility, not
  // window.__modalOpen: the Audit escape handler also fires and resets that).
  window.addEventListener('keydown',function(e){
    if(e.key!=='Escape') return;
    prtCloseMenu();
    var o=el('prt-overlay'); if(o&&!o.hidden) closePartnerOrders();
    var io=el('prt-info-overlay'); if(io&&!io.hidden) closePartnerInfo();
    var po=el('prt-payout-overlay'); if(po&&!po.hidden) closePartnerPayout();
  });
  var ends=el('prt-ends');
  if(ends&&!ends.value){ var d=new Date(Date.now()+30*86400000); ends.value=d.toISOString().slice(0,10); }
  loadDiscountStatus();
  // Self-serve Applications card: its own delegated listener, separate from
  // #prt-list above (a different container, a different id namespace).
  var applist=el('prt-app-list');
  if(applist) applist.addEventListener('click',function(e){
    var t=e.target;
    if(!t||!t.getAttribute) return;
    var id=t.getAttribute('data-prt-app-approve');
    if(id&&prtArm(t,'Click again to approve')){ prtApproveApplication(t); return; }
    if(id) return;
    id=t.getAttribute('data-prt-app-decline');
    if(id&&prtArm(t,'Click again to decline')){ prtDeclineApplication(t); return; }
  });
  loadApplications();
})();
`;
