// Campaigns view browser JS. Same template-literal rules as the other *-js
// modules: browser JS inside a TS template literal - no backticks or
// dollar-brace, double-escape backslashes, esc() every dynamic value.
//
// Composed AFTER partnersJs in page.ts on purpose: reuses its prtWhen() date
// formatter and prtArm() two-click arming (sending a broadcast is at least as
// consequential as revoking a voucher, so it gets the same armed button).
//
// Sending auto-continues: the API sends a bounded batch per call and reports
// remaining; the loop keeps calling until nothing remains, showing progress.
// A call that makes no progress stops the loop instead of hammering the API.
export const campaignsJs = `
// --- Campaigns: consented marketing broadcasts (HITL) ---
var cmpState={postal:'',testAddress:null,list:[],editingId:null};
function cmpChip(s){
  if(s==='sent') return '<span class="cmp-chip cmp-sent">sent</span>';
  if(s==='sending') return '<span class="cmp-chip cmp-sending">sending</span>';
  if(s==='paused') return '<span class="cmp-chip cmp-paused">paused</span>';
  if(s==='cancelled') return '<span class="cmp-chip cmp-cancelled">stopped</span>';
  return '<span class="cmp-chip cmp-draft">draft</span>';
}
function cmpAudienceLabel(a){ return a==='partners'?'Partners (opted in)':'Buyers (marketing opt-in)'; }
function cmpParas(t){
  var parts=String(t).split(/\\n{2,}/); var h='';
  for(var i=0;i<parts.length;i++){ var p=parts[i].trim(); if(!p) continue; h+='<p>'+esc(p).replace(/\\n/g,'<br>')+'</p>'; }
  return h;
}
function cmpRowHtml(cp){
  // Per-status controls: drafts are editable, an in-flight send can be
  // paused or stopped, a paused one resumed or stopped, and anything
  // finished (sent or stopped) can be duplicated as a fresh draft.
  var actions='<button class="ghost" type="button" data-cmp-test="'+esc(cp.id)+'">Send myself a test</button>';
  if(cp.status==='draft'){
    actions+='<button class="ghost" type="button" data-cmp-send="'+esc(cp.id)+'">Send now</button>'
      +'<button class="ghost" type="button" data-cmp-edit="'+esc(cp.id)+'">Edit</button>'
      +'<button class="ghost" type="button" data-cmp-discard="'+esc(cp.id)+'">Discard</button>';
  }else if(cp.status==='sending'){
    actions+='<button class="ghost" type="button" data-cmp-send="'+esc(cp.id)+'">Continue send</button>'
      +'<button class="ghost" type="button" data-cmp-pause="'+esc(cp.id)+'">Pause</button>'
      +'<button class="ghost" type="button" data-cmp-cancel="'+esc(cp.id)+'">Stop</button>';
  }else if(cp.status==='paused'){
    actions+='<button class="ghost" type="button" data-cmp-resume="'+esc(cp.id)+'">Resume send</button>'
      +'<button class="ghost" type="button" data-cmp-cancel="'+esc(cp.id)+'">Stop</button>';
  }else{
    actions+='<button class="ghost" type="button" data-cmp-dup="'+esc(cp.id)+'">Duplicate as draft</button>';
  }
  var stats='<span>Audience '+esc(cmpAudienceLabel(cp.audience))+'</span>';
  if(cp.recipientCount!=null) stats+='<span>Sent <strong>'+esc(cp.sentCount||0)+'</strong> of <strong>'+esc(cp.recipientCount)+'</strong></span>';
  if(cp.metrics){
    var m=cp.metrics;
    stats+='<span>Delivered <strong>'+esc(m.delivered||0)+'</strong></span>'
      +'<span>Opened <strong>'+esc(m.opened||0)+'</strong></span>'
      +'<span>Clicked <strong>'+esc(m.clicked||0)+'</strong></span>';
    if(m.bounced) stats+='<span>Bounced <strong>'+esc(m.bounced)+'</strong></span>';
    if(m.complained) stats+='<span>Spam complaints <strong>'+esc(m.complained)+'</strong></span>';
  }
  stats+='<span>Created '+prtWhen(cp.createdAt)+'</span>';
  if(cp.sentAt) stats+='<span>Completed '+prtWhen(cp.sentAt)+'</span>';
  return '<div class="cmp-row">'
    +'<div class="cmp-head"><span class="cmp-subj">'+esc(cp.subject)+'</span>'+cmpChip(cp.status)
    +'<span class="cmp-time">'+prtWhen(cp.createdAt)+'</span></div>'
    +'<div class="cmp-stats">'+stats+'</div>'
    +'<div class="cmp-actions">'+actions+'</div>'
    +'</div>';
}
async function loadCampaigns(){
  try{
    var r=await api('/campaigns',{});
    if(!r.ok){ setMsg('cmp-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    cmpState.postal=r.postalAddress||'';
    cmpState.testAddress=r.testAddress||null;
    cmpState.list=r.campaigns||[];
    var pi=el('cmp-postal'); if(pi&&!pi.value) pi.value=cmpState.postal;
    var box=el('cmp-list'); if(!box) return;
    var h='';
    for(var i=0;i<r.campaigns.length;i++) h+=cmpRowHtml(r.campaigns[i]);
    box.innerHTML=h||'<p class="muted">No campaigns yet. Compose one below - it saves as a draft and nothing sends until you click send.</p>';
    cmpLoadAudiences();
    cmpLoadTracking();
    lglCheck();
  }catch(e){ setMsg('cmp-msg','Could not load campaigns.','no'); }
}
// --- Privacy policy wording keeper: check live policy + one-click apply ---
async function lglCheck(){
  var box=el('lgl-status'); if(!box) return;
  try{
    var r=await api('/legal/check',{});
    var acts=el('lgl-actions');
    if(!r.ok){
      box.textContent=(r.error==='reconnect_required')
        ?'PawScout does not have policy access yet. Add the legal policies scopes in the app settings, then reopen this page.'
        :'Could not read the policy: '+(r.error||'unknown error');
      if(acts) acts.hidden=true;
      return;
    }
    if(r.upToDate){
      box.innerHTML='Your privacy policy already carries the recommended wording. Nothing to do.';
      if(acts) acts.hidden=true;
      return;
    }
    if(r.templateRecognized===false){
      box.textContent='The policy text does not look like the standard template, so no automatic update is offered. If you just turned automatic management off and the policy came back empty, restore it from the template in Settings, then reopen this page.';
      if(acts) acts.hidden=true;
      return;
    }
    var h='The live policy is missing:<ul style="margin:8px 0 0 18px">';
    for(var i=0;i<r.changes.length;i++) h+='<li>'+esc(r.changes[i])+'</li>';
    box.innerHTML=h+'</ul>';
    if(acts) acts.hidden=false;
  }catch(e){ box.textContent='Could not check the policy.'; }
}
async function lglApply(btn){
  if(!prtArm(btn,'Click again to update the live policy')) return;
  setMsg('lgl-msg','Updating the policy…','muted');
  try{
    var r=await api('/legal/apply',{});
    if(!r.ok){ setMsg('lgl-msg','Update failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('lgl-msg',(r.applied&&r.applied.length)?'Policy updated ('+r.applied.length+' edits). Check it at /policies/privacy-policy.':'Nothing to change - the policy was already up to date.','ok');
    lglCheck();
  }catch(e){ setMsg('lgl-msg','Update failed.','no'); }
}
// --- Email analytics: tracking status + one-click worker-side setup ---
async function cmpLoadTracking(){
  var box=el('cmp-tracking'); if(!box) return;
  try{
    var r=await api('/email-tracking',{});
    if(!r.ok){ box.textContent='Tracking status unavailable.'; return; }
    if(!r.available){ box.textContent='Email sending is not configured on the worker yet.'; return; }
    var acts=el('cmp-tracking-actions');
    if(r.openTracking&&r.clickTracking&&r.secretStored){
      box.innerHTML='Tracking is <strong>on</strong>. Deliveries, opens, clicks and bounces are recorded for every email sent from now on.';
      if(acts) acts.hidden=true;
      return;
    }
    box.textContent='Open/click tracking: '+((r.openTracking&&r.clickTracking)?'on':'off')
      +' · Event feed: '+(r.secretStored?'connected':'not connected')
      +(r.error?' ('+r.error+')':'');
    if(acts) acts.hidden=false;
  }catch(e){ box.textContent='Tracking status unavailable.'; }
}
async function cmpEnableTracking(){
  setMsg('cmp-tracking-msg','Setting up tracking…','muted');
  try{
    var r=await api('/email-tracking/setup',{});
    if(!r.ok){ setMsg('cmp-tracking-msg','Setup failed: '+(r.error||'unknown error'),'no'); return; }
    if(!r.secretStored){ setMsg('cmp-tracking-msg','Tracking is on, but an event webhook already exists in Resend and its secret is not stored here. Delete that webhook in the Resend dashboard, then click again.','no'); }
    else{ setMsg('cmp-tracking-msg','Done. Every email from now on reports delivery, opens and clicks back to this page.','ok'); }
    cmpLoadTracking();
  }catch(e){ setMsg('cmp-tracking-msg','Setup failed.','no'); }
}
async function cmpLoadAudiences(){
  var box=el('cmp-audiences'); if(!box) return;
  try{
    var r=await api('/campaigns/audiences',{});
    if(!r.ok){ box.textContent='Audience sizes unavailable.'; return; }
    var h='<span>Buyers with marketing opt-in: <strong>'+(r.buyers==null?'unavailable':esc(r.buyers))+'</strong></span>'
      +'<span>Partners opted in: <strong>'+esc(r.partners)+'</strong></span>';
    if(r.buyersError) h+='<span class="muted">('+esc(r.buyersError)+')</span>';
    box.innerHTML=h;
  }catch(e){ box.textContent='Audience sizes unavailable.'; }
}
async function cmpCreate(){
  var body={
    audience:el('cmp-audience').value,
    subject:el('cmp-subject').value.trim(),
    bodyText:el('cmp-body').value.trim()
  };
  if(!body.subject){ setMsg('cmp-new-msg','Give the campaign a subject.','no'); return; }
  if(body.bodyText.length<10){ setMsg('cmp-new-msg','Write the message first (at least a sentence).','no'); return; }
  var editing=cmpState.editingId;
  if(editing) body.id=editing;
  setMsg('cmp-new-msg','Saving…','muted');
  try{
    var r=await api(editing?'/campaigns/update':'/campaigns/create',body);
    if(!r.ok){ setMsg('cmp-new-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('cmp-new-msg',editing?'Draft updated.':'Saved as a draft. Send yourself a test from the list above, then send it for real.','ok');
    cmpEditCancel(true);
    loadCampaigns();
  }catch(e){ setMsg('cmp-new-msg','Could not save the campaign.','no'); }
}
// Edit fills the composer with the draft and flips it to save-changes mode;
// cancel (or a successful save) empties it back to compose mode.
function cmpEdit(id){
  var cp=null;
  for(var i=0;i<cmpState.list.length;i++) if(cmpState.list[i].id===id){ cp=cmpState.list[i]; break; }
  if(!cp){ setMsg('cmp-msg','Could not find that draft - reload the page.','no'); return; }
  if(cp.status!=='draft'){ setMsg('cmp-msg','Only drafts can be edited. Duplicate it instead.','no'); return; }
  cmpState.editingId=id;
  el('cmp-audience').value=cp.audience;
  el('cmp-subject').value=cp.subject;
  el('cmp-body').value=cp.bodyText||'';
  var t=el('cmp-compose-title'); if(t) t.textContent='Edit campaign';
  var b=el('cmp-save-btn'); if(b) b.textContent='Save changes';
  var x=el('cmp-edit-cancel'); if(x) x.hidden=false;
  var card=el('cmp-compose-card'); if(card&&card.scrollIntoView) card.scrollIntoView({behavior:'smooth',block:'start'});
  setMsg('cmp-new-msg','Editing "'+cp.subject+'". Save changes or cancel.','muted');
}
function cmpEditCancel(keepMsg){
  cmpState.editingId=null;
  el('cmp-subject').value=''; el('cmp-body').value='';
  var t=el('cmp-compose-title'); if(t) t.textContent='New campaign';
  var b=el('cmp-save-btn'); if(b) b.textContent='Save campaign';
  var x=el('cmp-edit-cancel'); if(x) x.hidden=true;
  var pv=el('cmp-preview'); if(pv) pv.hidden=true;
  if(keepMsg!==true) setMsg('cmp-new-msg','','muted');
}
function cmpTogglePreview(){
  var pv=el('cmp-preview'); if(!pv) return;
  if(!pv.hidden){ pv.hidden=true; return; }
  var body=el('cmp-body').value.trim();
  if(!body){ setMsg('cmp-new-msg','Write the message first, then preview it.','no'); return; }
  var postal=el('cmp-postal').value.trim()||cmpState.postal;
  pv.innerHTML='<p><strong>'+esc(el('cmp-subject').value.trim()||'(no subject yet)')+'</strong></p>'
    +cmpParas(body)
    +'<p>- The Active Paw team</p>'
    +'<p class="cmp-small">Active Paw, '+(postal?esc(postal):'(postal address not saved yet - sending is blocked until it is)')+'<br>'
    +'<u>Unsubscribe</u> from marketing emails.</p>';
  pv.hidden=false;
}
async function cmpTest(id){
  setMsg('cmp-msg','Sending the test…','muted');
  try{
    var r=await api('/campaigns/test',{id:id});
    if(!r.ok){ setMsg('cmp-msg','Test failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('cmp-msg','Test sent to '+(r.to||'your alert address')+'. Check it before sending for real.','ok');
  }catch(e){ setMsg('cmp-msg','Test failed.','no'); }
}
async function cmpSend(id){
  setMsg('cmp-msg','Sending…','muted');
  var guard=0,last=-1;
  try{
    while(guard++<60){
      var r=await api('/campaigns/send',{id:id});
      if(!r.ok){ setMsg('cmp-msg','Send stopped: '+(r.error||'unknown error'),'no'); break; }
      var done=(r.already||0)+(r.sent||0);
      if(r.remaining>0){
        setMsg('cmp-msg','Sent '+done+' so far, '+r.remaining+' to go…','muted');
        if(r.sent===0&&r.remaining>=last&&last>=0){ setMsg('cmp-msg','Send paused: no progress ('+r.failed+' failures). Click send again to retry.','no'); break; }
        last=r.remaining;
        continue;
      }
      setMsg('cmp-msg','Campaign sent: '+done+' delivered'+(r.suppressed?', '+r.suppressed+' suppressed (unsubscribed)':'')+'.','ok');
      break;
    }
  }catch(e){ setMsg('cmp-msg','Send failed. Click send again to resume - nobody gets duplicates.','no'); }
  loadCampaigns();
}
async function cmpDiscard(id){
  try{
    var r=await api('/campaigns/discard',{id:id});
    if(!r.ok){ setMsg('cmp-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('cmp-msg','Draft discarded.','ok');
    loadCampaigns();
  }catch(e){ setMsg('cmp-msg','Could not discard.','no'); }
}
// Pause is instant and reversible (single click); the batch already in
// flight finishes (at most 25 emails), then sending refuses until Resume.
async function cmpPause(id){
  try{
    var r=await api('/campaigns/pause',{id:id});
    if(!r.ok){ setMsg('cmp-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('cmp-msg','Paused. Nobody else is emailed until you click Resume.','ok');
    loadCampaigns();
  }catch(e){ setMsg('cmp-msg','Could not pause.','no'); }
}
async function cmpResume(id){
  try{
    var r=await api('/campaigns/resume',{id:id});
    if(!r.ok){ setMsg('cmp-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    cmpSend(id);
  }catch(e){ setMsg('cmp-msg','Could not resume.','no'); }
}
async function cmpCancel(id){
  try{
    var r=await api('/campaigns/cancel',{id:id});
    if(!r.ok){ setMsg('cmp-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('cmp-msg','Stopped. Recipients already emailed stay on record; duplicate the campaign to send again.','ok');
    loadCampaigns();
  }catch(e){ setMsg('cmp-msg','Could not stop.','no'); }
}
async function cmpDup(id){
  try{
    var r=await api('/campaigns/duplicate',{id:id});
    if(!r.ok){ setMsg('cmp-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('cmp-msg','Duplicated as a new draft - edit it below or send it as is.','ok');
    loadCampaigns();
  }catch(e){ setMsg('cmp-msg','Could not duplicate.','no'); }
}
async function cmpSavePostal(){
  var v=el('cmp-postal').value.trim();
  setMsg('cmp-postal-msg','Saving…','muted');
  try{
    var cur=await api('/inbox/config',{});
    if(!cur.ok||!cur.inbox){ setMsg('cmp-postal-msg','Could not load current settings.','no'); return; }
    var body=cur.inbox; body.postalAddress=v;
    var r=await api('/inbox/config',body);
    if(!r.ok){ setMsg('cmp-postal-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    cmpState.postal=v;
    setMsg('cmp-postal-msg',v?'Saved. Campaigns can now send.':'Cleared. Campaigns will not send until an address is saved.',v?'ok':'muted');
  }catch(e){ setMsg('cmp-postal-msg','Could not save the address.','no'); }
}
(function(){
  var list=el('cmp-list');
  if(list) list.addEventListener('click',function(e){
    var t=e.target;
    if(!t||!t.getAttribute) return;
    var id=t.getAttribute('data-cmp-test');
    if(id){ cmpTest(id); return; }
    id=t.getAttribute('data-cmp-send');
    if(id&&prtArm(t,'Click again to send to everyone')) cmpSend(id);
    if(id) return;
    id=t.getAttribute('data-cmp-resume');
    if(id&&prtArm(t,'Click again to resume sending')) cmpResume(id);
    if(id) return;
    id=t.getAttribute('data-cmp-pause');
    if(id){ cmpPause(id); return; }
    id=t.getAttribute('data-cmp-cancel');
    if(id&&prtArm(t,'Click again to stop this campaign for good')) cmpCancel(id);
    if(id) return;
    id=t.getAttribute('data-cmp-edit');
    if(id){ cmpEdit(id); return; }
    id=t.getAttribute('data-cmp-dup');
    if(id){ cmpDup(id); return; }
    id=t.getAttribute('data-cmp-discard');
    if(id&&prtArm(t,'Click again to discard')) cmpDiscard(id);
  });
})();
// --- Storewide events: create/end from the console; the Shopify discount is
// the ONLY record (its schedule controls checkout; the storefront modal and
// voucher deferral both read it live). Probe shared with the Partners view.
function evPromoLine(p){
  var when=(p.status==='ACTIVE'?'running':'scheduled')+(p.endsAt?(', ends '+prtWhen(p.endsAt)):', no end date');
  var h='"'+esc(p.title)+'" ('+esc(when)+(p.percentage!=null?(', '+esc(p.percentage)+'% off'):'')+')';
  if(p.source==='code'&&p.code&&p.status==='ACTIVE') h+=' <button class="ghost" type="button" data-ev-end="'+esc(p.code)+'">End now</button>';
  return h;
}
async function evLoad(){
  var box=el('ev-promos'); if(!box) return;
  try{
    var r=await api('/partners/discount-status',{});
    if(!r.ok||!r.scope){ box.textContent='Event check unavailable'+((r&&r.note)?(': '+r.note):'.'); return; }
    if(!r.promos.length){ box.textContent='No storewide event is running or scheduled.'; return; }
    var parts=[];
    for(var i=0;i<r.promos.length;i++) parts.push(evPromoLine(r.promos[i]));
    box.innerHTML=parts.join(' · ');
  }catch(e){ box.textContent='Event check unavailable.'; }
}
async function evCreate(btn){
  if(!prtArm(btn,'Click again to create the event')) return;
  var body={
    code:el('ev-code').value.trim().toUpperCase(),
    pctOff:Number(el('ev-pct').value),
    startDate:el('ev-start').value,
    endDate:el('ev-end').value,
    stageCampaign:!!el('ev-stage-chk').checked
  };
  setMsg('ev-msg','Creating the event in Shopify…','muted');
  try{
    var r=await api('/event/create',body);
    if(!r.ok){ setMsg('ev-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    var msg='Created '+r.code+'. It works at checkout only between '+prtWhen(r.startsAt)+' and '+prtWhen(r.endsAt)+' - the schedule lives inside the discount, and the storefront modal follows it automatically.';
    if(r.campaignId) msg+=' The announcement draft is in the campaign list above: review, send yourself a test, then send.';
    msg+=' Reminder: the modal headline wording lives in Theme settings, Welcome offer - update it there if this event needs different words.';
    setMsg('ev-msg',msg,'ok');
    el('ev-code').value='';
    evLoad(); loadCampaigns();
  }catch(e){ setMsg('ev-msg','Could not create the event.','no'); }
}
async function evEnd(code){
  try{
    var r=await api('/event/end',{code:code});
    if(!r.ok){ setMsg('ev-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('ev-msg','Ended. The code is deactivated in Shopify immediately and the storefront modal clears within about 10 minutes.','ok');
    evLoad();
  }catch(e){ setMsg('ev-msg','Could not end the event.','no'); }
}
(function(){
  var box=el('ev-promos');
  if(box) box.addEventListener('click',function(e){
    var t=e.target;
    if(!t||!t.getAttribute) return;
    var code=t.getAttribute('data-ev-end');
    if(code&&prtArm(t,'Click again to end the event')) evEnd(code);
  });
  evLoad();
})();
`;
